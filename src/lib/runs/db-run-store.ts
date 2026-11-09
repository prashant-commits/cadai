import * as crypto from 'crypto';
import { requireTransaction, type Queryable } from '@/lib/db/db';
import {
  notFound,
  needsProject,
  wrongProject,
  runActive,
  staleClient,
  badPin,
  rowToRun,
  StoreError,
  type StartInput,
  type CommitPlan,
  type RunRow,
  type EndEvent,
  type RunStatus,
} from '@/lib/persist/types';
import {
  TERMINATE_REPLY,
  userEditSummary,
  BUSY,
  BUDGET_USED,
  type TerminateCode,
} from '@/lib/persist/phrases';
import { applyPins, BadPinError } from '@/lib/design/write-params';
import { maxRunning, dailyCostUsd } from '@/lib/runs/config';
import { MAX_COST_USD } from '@/lib/agent/designer/cost-params';
import { buildTranscript } from '@/lib/agent/transcript-build';
import { parseOpBlocks, type ToolOp } from '@/lib/tools/ops';
import { toolEditPhrase, toolEditActionPhrase } from '@/lib/tools/phrases';

export const RUN_START_LOCK_ID = BigInt('723948192847192842');

interface EndRunOptions {
  status?: 'cancelled' | 'failed';
  code?: TerminateCode;
  costUsd?: number;
  isReap?: boolean;
}

async function endRun(
  q: Queryable,
  runId: string,
  opts: EndRunOptions
): Promise<{ ended: true; end: EndEvent } | { ended: false }> {
  // 1. Read thread_id with no lock
  const runRes = await q.query(`SELECT thread_id FROM runs WHERE id = $1`, [runId]);
  if (runRes.rows.length === 0) {
    return { ended: false };
  }
  const threadId = String(runRes.rows[0].thread_id);

  // 2. Lock thread FOR UPDATE
  await q.query(`SELECT id FROM threads WHERE id = $1 FOR UPDATE`, [threadId]);

  // 3. Guarded UPDATE on runs
  let updateRes;
  if (opts.isReap) {
    const staleMs = Number(process.env.CADAI_STALE_MS) || 90000;
    updateRes = await q.query(
      `UPDATE runs
       SET status = 'failed',
           error = jsonb_build_object(
             'code',
             CASE WHEN deadline_at + interval '60 seconds' <= now() THEN 'deadline' ELSE 'run_lost' END
           ),
           ended_at = now(),
           updated_at = now(),
           last_seq = last_seq + 1
       WHERE id = $1
         AND status = 'running'
         AND (
           heartbeat_at < now() - ($2 * interval '1 millisecond')
           OR deadline_at + interval '60 seconds' <= now()
         )
       RETURNING last_seq, error->>'code' AS code`,
      [runId, staleMs]
    );
  } else {
    updateRes = await q.query(
      `UPDATE runs
       SET status = $2,
           error = jsonb_build_object('code', $3::text),
           cost_usd = coalesce($4, cost_usd),
           ended_at = now(),
           updated_at = now(),
           last_seq = last_seq + 1
       WHERE id = $1 AND status = 'running'
       RETURNING last_seq, error->>'code' AS code`,
      [runId, opts.status!, opts.code!, opts.costUsd ?? null]
    );
  }

  if (updateRes.rowCount === 0) {
    return { ended: false };
  }

  const lastSeq = Number(updateRes.rows[0].last_seq);
  const resolvedCode = String(updateRes.rows[0].code) as TerminateCode;
  const resolvedStatus = (opts.isReap ? 'failed' : opts.status!) as Exclude<RunStatus, 'running'>;
  const replyInfo = TERMINATE_REPLY[resolvedCode];

  // 4. Assistant reply
  const evRes = await q.query(
    `SELECT type, payload FROM run_events
     WHERE run_id = $1 AND type IN ('section', 'delta')
     ORDER BY seq DESC LIMIT 200`,
    [runId]
  );
  const events = evRes.rows.reverse().map((r) =>
    typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload
  );
  const stepsNodes = buildTranscript(events, resolvedStatus);
  const stepsJson = JSON.stringify(stepsNodes);

  const msgRes = await q.query(
    `INSERT INTO messages (
      id, thread_id, seq, role, kind, content, run_id, design_version, steps
    ) VALUES (
      gen_random_uuid(),
      $1,
      coalesce((SELECT max(seq) FROM messages WHERE thread_id = $1), 0) + 1,
      'assistant',
      $2,
      $3,
      $4,
      null,
      $5::jsonb
    ) RETURNING id`,
    [threadId, replyInfo.kind, replyInfo.markdown, runId, stepsJson]
  );
  const assistantMessageId = String(msgRes.rows[0].id);

  // 5. Insert end event
  const end: EndEvent = {
    t: 'end',
    seq: lastSeq,
    status: resolvedStatus,
    reply: {
      messageId: assistantMessageId,
      kind: replyInfo.kind,
      markdown: replyInfo.markdown,
    },
  };

  await q.query(
    `INSERT INTO run_events(run_id, seq, type, payload)
     VALUES ($1, $2, 'end', $3)`,
    [runId, lastSeq, JSON.stringify(end)]
  );

  // 6. Conditionally clear active_run_id
  await q.query(
    `UPDATE threads
     SET active_run_id = null,
         updated_at = now()
     WHERE id = $1 AND active_run_id = $2`,
    [threadId, runId]
  );

  return { ended: true, end };
}

async function start(
  q: Queryable,
  input: StartInput
): Promise<
  | { replay: true; runId: string }
  | {
      replay: false;
      runId: string;
      threadId: string;
      baseVersion: number | null;
      userMessageId: string;
    }
> {
  requireTransaction();

  // Step 1: Thread check and lock
  const preCheck = await q.query(
    `SELECT owner_key, archived_at, project_id FROM threads WHERE id = $1`,
    [input.threadId]
  );

  if (preCheck.rows.length === 0) {
    if (!input.projectId) {
      throw needsProject();
    }
    const projRes = await q.query(
      `SELECT owner_key, archived_at FROM projects WHERE id = $1 FOR SHARE`,
      [input.projectId]
    );
    if (
      projRes.rows.length === 0 ||
      projRes.rows[0].owner_key !== input.ownerKey ||
      projRes.rows[0].archived_at !== null
    ) {
      throw notFound();
    }
    await q.query(
      `INSERT INTO threads(id, owner_key, project_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [input.threadId, input.ownerKey, input.projectId]
    );
  }

  const threadRes = await q.query(
    `SELECT owner_key, archived_at, active_run_id, project_id FROM threads WHERE id = $1 FOR UPDATE`,
    [input.threadId]
  );

  if (threadRes.rows.length === 0) {
    throw notFound();
  }
  const threadRow = threadRes.rows[0];
  if (
    threadRow.owner_key !== input.ownerKey ||
    threadRow.archived_at !== null
  ) {
    throw notFound();
  }

  if (
    input.projectId !== undefined &&
    input.projectId !== null &&
    input.projectId !== threadRow.project_id
  ) {
    throw wrongProject();
  }

  // Step 2: Idempotency (replay)
  const replayRes = await q.query(
    `SELECT run_id FROM messages WHERE thread_id = $1 AND client_message_id = $2 AND role = 'user'`,
    [input.threadId, input.clientMessageId]
  );
  if (replayRes.rows.length > 0) {
    return {
      replay: true,
      runId: String(replayRes.rows[0].run_id),
    };
  }

  // Step 3: Active run check
  if (threadRow.active_run_id) {
    const activeRunId = String(threadRow.active_run_id);
    const runStatusRes = await q.query(
      `SELECT status FROM runs WHERE id = $1`,
      [activeRunId]
    );
    if (runStatusRes.rows.length > 0 && runStatusRes.rows[0].status === 'running') {
      const reaped = await reap(q, activeRunId);
      if (!reaped) {
        throw runActive(activeRunId);
      }
    }
  }

  // Step 4: Base design check
  const designsRes = await q.query(
    `SELECT version, body, base_request, edits, prelude_version FROM designs WHERE thread_id = $1 ORDER BY version ASC`,
    [input.threadId]
  );
  const threadDesigns = designsRes.rows;

  let baseDesign: (typeof threadDesigns)[number] | null = null;
  let baseVersion: number | null = null;

  if (threadDesigns.length > 0) {
    if (input.viewingVersion === null || input.viewingVersion === undefined) {
      throw staleClient();
    }
    const found = threadDesigns.find(
      (d) => Number(d.version) === input.viewingVersion
    );
    if (!found) {
      throw notFound();
    }
    baseDesign = found;
    baseVersion = input.viewingVersion;
  } else {
    if (input.viewingVersion !== null && input.viewingVersion !== undefined) {
      throw notFound();
    }
    baseDesign = null;
    baseVersion = null;
  }

  // Step 5: Pins validation
  const hasPins =
    input.pinnedParams !== undefined &&
    input.pinnedParams !== null &&
    Object.keys(input.pinnedParams).length > 0;

  if (hasPins) {
    const targetBody =
      input.editedBody ?? (baseDesign ? String(baseDesign.body) : null);
    if (targetBody === null) {
      throw badPin();
    }
    try {
      applyPins(targetBody, input.pinnedParams!);
    } catch (err) {
      if (err instanceof BadPinError) {
        throw badPin();
      }
      throw err;
    }
  }

  // Step 6: Attachments validation
  const rawAttachments =
    input.attachments ??
    (input.attachmentIds?.map((id) => ({ id, kind: 'reference' as const })) ?? []);

  if (rawAttachments.length > 0) {
    for (const att of rawAttachments) {
      const artRes = await q.query(
        `SELECT 1 FROM artifacts WHERE id = $1 AND owner_key = $2 AND kind = 'image'`,
        [att.id, input.ownerKey]
      );
      if (artRes.rows.length === 0) {
        throw notFound();
      }
    }
  }

  // Running cap and Daily cost ceiling checks
  const maxRun = maxRunning();
  const capOn = maxRun > 0;
  const dailyCost = dailyCostUsd();
  const ceilingOn = dailyCost !== null;

  if (capOn || ceilingOn) {
    await q.query(`SELECT pg_advisory_xact_lock(${RUN_START_LOCK_ID})`);

    // 1. Busy check
    if (capOn) {
      const staleMs = Number(process.env.CADAI_STALE_MS) || 90000;
      const runningRes = await q.query<{ count: string | number }>(
        `SELECT count(*) as count FROM runs
         WHERE status = 'running'
           AND NOT (
             heartbeat_at < now() - ($1 * interval '1 millisecond')
             OR deadline_at + interval '60 seconds' <= now()
           )`,
        [staleMs]
      );
      const runningCount = Number(runningRes.rows[0].count);
      if (runningCount >= maxRun) {
        throw new StoreError(429, 'busy', BUSY);
      }
    }

    // 2. Budget check
    if (ceilingOn) {
      const costRes = await q.query<{ spent: string | number }>(
        `SELECT coalesce(sum(cost_usd), 0) as spent
         FROM runs
         WHERE status <> 'running'
           AND ended_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
      );
      const spent = Number(costRes.rows[0].spent);
      const maxRunningForBudget = maxRun > 0 ? maxRun : 4;
      if (spent + maxRunningForBudget * MAX_COST_USD >= dailyCost) {
        throw new StoreError(429, 'budget', BUDGET_USED);
      }
    }
  }

  // Step 7: User edits
  if (input.editedBody !== undefined && input.editedBody !== null && !baseDesign) {
    throw staleClient();
  }

  let codeChanged = false;
  let slidersChanged = false;
  let finalBody = baseDesign ? String(baseDesign.body) : '';

  if (baseDesign) {
    const baseBody = String(baseDesign.body);
    codeChanged =
      input.editedBody !== undefined &&
      input.editedBody !== null &&
      input.editedBody !== baseBody;

    const bodyAfterCode = input.editedBody ?? baseBody;
    if (hasPins) {
      const bodyAfterPins = applyPins(bodyAfterCode, input.pinnedParams!);
      slidersChanged = bodyAfterPins !== bodyAfterCode;
      finalBody = bodyAfterPins;
    } else {
      finalBody = bodyAfterCode;
    }

    if (codeChanged || slidersChanged) {
      const maxVRes = await q.query(
        `SELECT coalesce(max(version), 0) as max_v FROM designs WHERE thread_id = $1`,
        [input.threadId]
      );
      const nextVersion = Number(maxVRes.rows[0].max_v) + 1;
      const summary = userEditSummary(codeChanged, slidersChanged);

      const editsJson =
        typeof baseDesign.edits === 'string'
          ? baseDesign.edits
          : JSON.stringify(baseDesign.edits ?? []);

      await q.query(
        `INSERT INTO designs(
          thread_id, version, parent_version, origin, run_id,
          base_request, edits, body, prelude_version, summary,
          facts, flags, stl_artifact, step_artifact
        ) VALUES (
          $1, $2, $3, 'user_edit', null,
          $4, $5, $6, $7, $8,
          null, '[]'::jsonb, null, null
        )`,
        [
          input.threadId,
          nextVersion,
          baseVersion,
          baseDesign.base_request,
          editsJson,
          finalBody,
          baseDesign.prelude_version,
          summary,
        ]
      );

      baseVersion = nextVersion;
    }
  }

  // Step 8: Insert the run and update thread
  const runId = crypto.randomUUID();
  const runMaxMs = Number(process.env.CADAI_RUN_MAX_MS) || 900000;

  await q.query(
    `INSERT INTO runs (
      id, thread_id, status, model, base_version,
      deadline_at, cost_usd, last_seq
    ) VALUES (
      $1, $2, 'running', $3, $4,
      now() + ($5 * interval '1 millisecond'), 0, 0
    )`,
    [
      runId,
      input.threadId,
      input.model ?? null,
      baseVersion,
      runMaxMs,
    ]
  );

  const firstLineRaw = input.text.split('\n')[0].trim();
  const firstLine = firstLineRaw.length > 0 ? firstLineRaw.slice(0, 80) : null;

  await q.query(
    `UPDATE threads
     SET active_run_id = $1,
         updated_at = now(),
         title = coalesce(title, $2)
     WHERE id = $3`,
    [runId, firstLine, input.threadId]
  );

  // Step 9: Insert user message and message_attachments
  const msgRes = await q.query(
    `INSERT INTO messages (
      id, thread_id, seq, role, kind, content, run_id, client_message_id
    ) VALUES (
      gen_random_uuid(),
      $1,
      coalesce((SELECT max(seq) FROM messages WHERE thread_id = $1), 0) + 1,
      'user',
      'unknown',
      $2,
      $3,
      $4
    ) RETURNING id`,
    [input.threadId, input.text, runId, input.clientMessageId]
  );
  const userMessageId = String(msgRes.rows[0].id);

  if (rawAttachments.length > 0) {
    const ids: string[] = [];
    for (const att of rawAttachments) {
      ids.push(att.id);
      await q.query(
        `INSERT INTO message_attachments (message_id, artifact_id, kind)
         VALUES ($1, $2, $3)`,
        [userMessageId, att.id, att.kind]
      );
    }
    await q.query(
      `UPDATE artifacts SET thread_id = $1, run_id = $2 WHERE id = ANY($3) AND owner_key = $4`,
      [input.threadId, runId, ids, input.ownerKey]
    );
  }

  return {
    replay: false,
    runId,
    threadId: input.threadId,
    baseVersion,
    userMessageId,
  };
}

async function commit(
  q: Queryable,
  runId: string,
  plan: CommitPlan
): Promise<{ committed: true; end: EndEvent } | { committed: false }> {
  requireTransaction();

  // 1. Read thread_id with no lock, then lock thread FOR UPDATE
  const runRes = await q.query(`SELECT thread_id FROM runs WHERE id = $1`, [runId]);
  if (runRes.rows.length === 0) {
    return { committed: false };
  }
  const threadId = String(runRes.rows[0].thread_id);

  await q.query(`SELECT id FROM threads WHERE id = $1 FOR UPDATE`, [threadId]);

  // 2. nextVersion if plan has design
  let nextVersion: number | null = null;
  if (plan.design) {
    const maxVRes = await q.query(
      `SELECT coalesce(max(version), 0) + 1 AS next_v FROM designs WHERE thread_id = $1`,
      [threadId]
    );
    nextVersion = Number(maxVRes.rows[0].next_v);
  }

  // 3. Guarded UPDATE on runs
  const updateRes = await q.query(
    `UPDATE runs
     SET status = 'done',
         design_version = $2,
         cost_usd = $3,
         wall_ms = $4,
         turns = $5,
         ended_at = now(),
         updated_at = now(),
         last_seq = last_seq + 1
     WHERE id = $1 AND status = 'running'
     RETURNING last_seq`,
    [runId, nextVersion, plan.costUsd, plan.wallMs, plan.turns]
  );
  if (updateRes.rowCount === 0) {
    return { committed: false };
  }
  const lastSeq = Number(updateRes.rows[0].last_seq);

  // 4. Insert design if provided
  if (plan.design && nextVersion !== null) {
    await q.query(
      `INSERT INTO designs (
        thread_id, version, parent_version, origin, run_id,
        base_request, edits, body, prelude_version, summary,
        facts, flags, stl_artifact, step_artifact
      ) VALUES (
        $1, $2, $3, 'designer', $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12, $13
      )`,
      [
        threadId,
        nextVersion,
        plan.design.parentVersion ?? null,
        runId,
        plan.design.baseRequest,
        JSON.stringify(plan.design.edits ?? []),
        plan.design.body,
        plan.design.preludeVersion,
        plan.design.summary,
        plan.design.facts ? JSON.stringify(plan.design.facts) : null,
        JSON.stringify(plan.design.flags ?? []),
        plan.design.stlArtifact ?? null,
        plan.design.stepArtifact ?? null,
      ]
    );
  }

  // 5. Assistant reply and update user message kind
  const evRes = await q.query(
    `SELECT type, payload FROM run_events
     WHERE run_id = $1 AND type IN ('section', 'delta')
     ORDER BY seq DESC LIMIT 200`,
    [runId]
  );
  const events = evRes.rows.reverse().map((r) =>
    typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload
  );
  const stepsNodes = buildTranscript(events, 'done');
  const stepsJson = JSON.stringify(stepsNodes);

  const msgRes = await q.query(
    `INSERT INTO messages (
      id, thread_id, seq, role, kind, content, run_id, design_version, steps
    ) VALUES (
      gen_random_uuid(),
      $1,
      coalesce((SELECT max(seq) FROM messages WHERE thread_id = $1), 0) + 1,
      'assistant',
      $2,
      $3,
      $4,
      $5,
      $6::jsonb
    ) RETURNING id`,
    [threadId, plan.replyKind, plan.replyMarkdown, runId, nextVersion, stepsJson]
  );
  const assistantMessageId = String(msgRes.rows[0].id);

  await q.query(
    `UPDATE messages
     SET kind = $1
     WHERE run_id = $2 AND role = 'user'`,
    [plan.userKind, runId]
  );

  // 6. run_events row (runId, last_seq, 'end', payload = EndEvent)
  const end: EndEvent = {
    t: 'end',
    seq: lastSeq,
    status: 'done',
    reply: {
      messageId: assistantMessageId,
      kind: plan.replyKind,
      markdown: plan.replyMarkdown,
    },
    ...(nextVersion !== null ? { designVersion: nextVersion } : {}),
  };

  await q.query(
    `INSERT INTO run_events(run_id, seq, type, payload)
     VALUES ($1, $2, 'end', $3)`,
    [runId, lastSeq, JSON.stringify(end)]
  );

  // 7. Clear active_run_id conditionally
  await q.query(
    `UPDATE threads
     SET active_run_id = null,
         updated_at = now()
     WHERE id = $1 AND active_run_id = $2`,
    [threadId, runId]
  );

  return { committed: true, end };
}

export interface CommitUserEditInput {
  ownerKey: string;
  threadId: string;
  baseVersion: number;
  body: string;
  op: ToolOp;
  clientMessageId: string;
  stlArtifact?: string | null;
  stepArtifact?: string | null;
  topoArtifact?: string | null;
  parts?: unknown[];
}

async function commitUserEdit(
  q: Queryable,
  input: CommitUserEditInput
): Promise<{ version: number }> {
  requireTransaction();

  // 1. Thread check and lock (order: threads, then runs)
  const threadRes = await q.query(
    `SELECT owner_key, archived_at, active_run_id FROM threads WHERE id = $1 FOR UPDATE`,
    [input.threadId]
  );
  if (threadRes.rows.length === 0) {
    throw notFound();
  }
  const threadRow = threadRes.rows[0];
  if (threadRow.owner_key !== input.ownerKey || threadRow.archived_at !== null) {
    throw notFound();
  }

  // 2. Active run check
  if (threadRow.active_run_id) {
    const activeRunId = String(threadRow.active_run_id);
    const runStatusRes = await q.query(`SELECT status FROM runs WHERE id = $1`, [activeRunId]);
    if (runStatusRes.rows.length > 0 && runStatusRes.rows[0].status === 'running') {
      const reaped = await reap(q, activeRunId);
      if (!reaped) {
        throw runActive(activeRunId);
      }
    }
  }

  // 3. Duplicate client message check
  const dupRes = await q.query(
    `SELECT id FROM messages WHERE thread_id = $1 AND client_message_id = $2`,
    [input.threadId, input.clientMessageId]
  );
  if (dupRes.rows.length > 0) {
    throw new StoreError(409, 'duplicate_message', 'Duplicate client message ID');
  }

  // 4. Base design check
  const baseDesignRes = await q.query(
    `SELECT version, base_request, edits, prelude_version FROM designs WHERE thread_id = $1 AND version = $2`,
    [input.threadId, input.baseVersion]
  );
  if (baseDesignRes.rows.length === 0) {
    throw notFound();
  }
  const baseDesign = baseDesignRes.rows[0];

  // 5. Next version
  const maxVRes = await q.query(
    `SELECT coalesce(max(version), 0) + 1 AS next_v FROM designs WHERE thread_id = $1`,
    [input.threadId]
  );
  const nextVersion = Number(maxVRes.rows[0].next_v);

  // 6. Parse ops and prepare fields
  const ops = parseOpBlocks(input.body).map((p) => p.op);
  const summary = toolEditActionPhrase(input.op);
  const facts = input.parts ? { parts: input.parts } : null;
  const editsJson =
    typeof baseDesign.edits === 'string'
      ? baseDesign.edits
      : JSON.stringify(baseDesign.edits ?? []);

  // 7. Insert designs row
  await q.query(
    `INSERT INTO designs(
      thread_id, version, parent_version, origin, run_id,
      base_request, edits, body, prelude_version, summary,
      facts, flags, stl_artifact, step_artifact, topo_artifact, ops
    ) VALUES (
      $1, $2, $3, 'user_edit', null,
      $4, $5, $6, $7, $8,
      $9, '[]'::jsonb, $10, $11, $12, $13::jsonb
    )`,
    [
      input.threadId,
      nextVersion,
      input.baseVersion,
      baseDesign.base_request,
      editsJson,
      input.body,
      baseDesign.prelude_version,
      summary,
      facts ? JSON.stringify(facts) : null,
      input.stlArtifact ?? null,
      input.stepArtifact ?? null,
      input.topoArtifact ?? null,
      JSON.stringify(ops),
    ]
  );

  // 8. Insert messages row
  const phrase = toolEditPhrase(input.op, nextVersion);
  await q.query(
    `INSERT INTO messages(
      id, thread_id, seq, role, kind, content, client_message_id, design_version
    ) VALUES (
      gen_random_uuid(),
      $1,
      coalesce((SELECT max(seq) FROM messages WHERE thread_id = $1), 0) + 1,
      'user',
      'tool_edit',
      $2,
      $3,
      $4
    )`,
    [input.threadId, phrase, input.clientMessageId, nextVersion]
  );

  // 9. Bump thread updated_at
  await q.query(
    `UPDATE threads SET updated_at = now() WHERE id = $1`,
    [input.threadId]
  );

  return { version: nextVersion };
}

async function terminate(
  q: Queryable,
  runId: string,
  status: 'cancelled' | 'failed',
  code: TerminateCode,
  costUsd?: number
): Promise<{ ended: true; end: EndEvent } | { ended: false }> {
  requireTransaction();
  return endRun(q, runId, { status, code, costUsd, isReap: false });
}

async function reap(q: Queryable, runId: string): Promise<boolean> {
  requireTransaction();
  const res = await endRun(q, runId, { isReap: true });
  return res.ended;
}

async function append(
  q: Queryable,
  runId: string,
  event: { type: string; payload: unknown }
): Promise<number> {
  const res = await q.query(
    `WITH r AS (
       UPDATE runs
       SET last_seq = last_seq + 1,
           heartbeat_at = now()
       WHERE id = $1 AND status = 'running'
       RETURNING last_seq
     )
     INSERT INTO run_events (run_id, seq, type, payload)
     SELECT $1, last_seq, $2, $3
     FROM r
     RETURNING seq`,
    [runId, event.type, JSON.stringify(event.payload)]
  );
  if (res.rows.length === 0) {
    return 0;
  }
  return Number(res.rows[0].seq);
}

async function heartbeat(
  q: Queryable,
  runId: string,
  costUsd: number
): Promise<number> {
  const res = await q.query(
    `UPDATE runs
     SET heartbeat_at = now(), cost_usd = $2
     WHERE id = $1 AND status = 'running'`,
    [runId, costUsd]
  );
  return res.rowCount;
}

async function eventsSince(
  q: Queryable,
  runId: string,
  afterSeq: number,
  limit = 500
): Promise<{ seq: number; type: string; payload: unknown; ts: number }[]> {
  const res = await q.query(
    `SELECT seq, type, payload, ts
     FROM run_events
     WHERE run_id = $1 AND seq > $2
     ORDER BY seq ASC
     LIMIT $3`,
    [runId, afterSeq, limit]
  );
  return res.rows.map((r) => ({
    seq: Number(r.seq),
    type: String(r.type),
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    ts: Number(r.ts),
  }));
}

async function get(q: Queryable, runId: string): Promise<RunRow | null> {
  const res = await q.query(`SELECT * FROM runs WHERE id = $1`, [runId]);
  if (res.rows.length === 0) return null;
  return rowToRun(res.rows[0]);
}

async function getForOwner(
  q: Queryable,
  ownerKey: string,
  runId: string
): Promise<RunRow | null> {
  const res = await q.query(
    `SELECT r.*
     FROM runs r
     JOIN threads t ON r.thread_id = t.id
     WHERE r.id = $1 AND t.owner_key = $2`,
    [runId, ownerKey]
  );
  if (res.rows.length === 0) return null;
  return rowToRun(res.rows[0]);
}

async function listStale(q: Queryable): Promise<string[]> {
  const staleMs = Number(process.env.CADAI_STALE_MS) || 90000;
  const res = await q.query(
    `SELECT id FROM runs
     WHERE status = 'running'
       AND (
         heartbeat_at < now() - ($1 * interval '1 millisecond')
         OR deadline_at + interval '60 seconds' <= now()
       )`,
    [staleMs]
  );
  return res.rows.map((r) => String(r.id));
}

export const DbRunStore = {
  start,
  commit,
  commitUserEdit,
  terminate,
  reap,
  append,
  heartbeat,
  eventsSince,
  get,
  getForOwner,
  listStale,
};
