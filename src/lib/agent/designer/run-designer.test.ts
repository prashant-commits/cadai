import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { checkPythonScript, GENERATED_PRELUDE, MAX_SCRIPT_BYTES, PRELUDE_SENTINEL } from '../../brep/body-check';
import type { BrepResult } from '../../engine/brep-runner';
import { runBrep } from '../../engine/brep-runner';
import { getChatModel } from '../model-provider';
import {
  MAX_COST_USD,
  MAX_TURNS,
  MAX_WALL_MS,
  MIN_DESIGNER_WALL_MS,
  designerWallBudgetMs,
  runDesigner,
} from './run-designer';
import type { DesignerEvent, ReviewFn, ReviewFlag, ReviewInput } from './types';
import { DESIGNER_SYSTEM_PROMPT } from './prompt';
import { withGeneratedPrelude } from '../../brep/prelude';
import { createDesignerNode } from './node';
import { REFUSAL } from '../../persist/phrases';

vi.mock('../../engine/brep-runner', () => ({ runBrep: vi.fn() }));
vi.mock('../model-provider', async (orig) => ({
  ...(await orig<typeof import('../model-provider')>()),
  getChatModel: vi.fn(),
}));

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 5\nendloop\nendfacet\nendsolid m\n';

const body = (lines: string[]) => `${GENERATED_PRELUDE}\n\n${PRELUDE_SENTINEL}\n\n${lines.join('\n')}\n`;
const PLAIN = body(['width = 40  # overall width', 'result = Box(width, 10, 10)']);
const POSED = body([
  'width = 40  # overall width',
  'lid_open_deg = 0  # [0:5:90] lid opening angle',
  'result = Box(width, 10, 10)',
]);
const POSED_CLASH_OPEN = `${POSED}# CLASH_OPEN\n`;
const POSED_BAD_DEFAULT = body(['width = 40  # w', 'lid_open_deg = 30  # [0:5:90] lid', 'result = Box(width, 10, 10)']);
const CLASHING = `${PLAIN}# CLASH\n`;
const BROKEN = `${PLAIN}# BROKEN\n`;

/** A stand-in for runBrep driven by markers in the script; asserts the guardrail passed for every run. */
function brepFor(script: string): BrepResult {
  expect(checkPythonScript(script).ok).toBe(true);
  if (script.includes('# BROKEN')) {
    return { ok: false, error: 'Traceback (most recent call last):\n  File "/srv/geo/run.py", line 9\nValueError: SECRET_TRACEBACK', parts: [], solids: 0, ms: 1 };
  }
  const open90 = /^lid_open_deg = 90 /m.test(script);
  const clash = script.includes('# CLASH\n') || (open90 && script.includes('# CLASH_OPEN'));
  return {
    ok: true,
    parts: [
      { label: 'body', valid: true, volume: 4000, min: [0, 0, 0], max: [40, 10, 10] },
      { label: 'lid', valid: true, volume: 400, min: [0, 0, 10], max: [40, 10, 12] },
    ],
    solids: 2,
    bbox: { min: [0, 0, 0], max: [40, 10, 12] },
    interferences: clash ? [{ a: 'body', b: 'lid', volume: 50 }] : [],
    disconnected: [],
    partMeshes: { body: STL, lid: STL },
    ms: 5,
  };
}

type Call = { name: string; args: Record<string, unknown> };
const run = (script: string): Call => ({ name: 'run_script', args: { script } });
const render = (overrides?: Record<string, number>): Call => ({ name: 'render', args: overrides ? { overrides } : {} });
const finish = (summary = 'Done.'): Call => ({ name: 'finish', args: { summary } });

let seq = 0;
function reply(calls: Call[], opts: { text?: string; outputTokens?: number } = {}): AIMessage {
  return new AIMessage({
    content: opts.text ?? '',
    tool_calls: calls.map((c) => ({ id: `t${++seq}`, name: c.name, args: c.args, type: 'tool_call' as const })),
    usage_metadata: { input_tokens: 1000, output_tokens: opts.outputTokens ?? 100, total_tokens: 1100 },
  });
}

/** Installs a scripted model. Each turn pops the next reply; the last one repeats when `repeat` is set. */
function installModel(script: AIMessage[] | ((turn: number) => AIMessage)) {
  const seen: BaseMessage[][] = [];
  const invoke = vi.fn(async (msgs: BaseMessage[], options?: unknown) => {
    void options;
    seen.push([...msgs]);
    const n = seen.length - 1;
    const next = typeof script === 'function' ? script(n) : script[n];
    if (!next) throw new Error('script exhausted');
    return next;
  });
  vi.mocked(getChatModel).mockReturnValue({ bindTools: () => ({ invoke }) } as never);
  return { invoke, seen };
}

function toolResults(msgs: BaseMessage[]): string[] {
  return msgs
    .filter((m): m is ToolMessage => m instanceof ToolMessage)
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n'),
    );
}

const flag = (severity: ReviewFlag['severity'], issue = 'it tips forward'): ReviewFlag => ({ severity, issue, whyItMatters: 'it falls over' });

beforeEach(() => {
  seq = 0;
  vi.mocked(runBrep).mockReset();
  vi.mocked(runBrep).mockImplementation(async (script: string) => brepFor(script));
  vi.mocked(getChatModel).mockReset();
});

describe('finish rules', () => {
  it('rejects finish before two run_script calls on a first build', async () => {
    const m = installModel([reply([run(PLAIN), render(), finish()]), reply([run(PLAIN), render(), finish()])]);
    const res = await runDesigner({ request: 'a box' }, {});
    expect(res.turns).toBe(2);
    expect(toolResults(m.seen[1]).some((t) => /at least 2 run_script calls are required/.test(t))).toBe(true);
    expect(res.failed).toBeUndefined();
    expect(res.summary).toBe('Done.');
  });

  it('needs a render after the last run_script', async () => {
    const m = installModel([
      reply([run(PLAIN), run(PLAIN), finish()]),
      reply([render(), finish('ok')]),
    ]);
    const res = await runDesigner({ request: 'a box' }, {});
    expect(toolResults(m.seen[1]).some((t) => /at least one render call is required after the last run_script/.test(t))).toBe(true);
    expect(res.summary).toBe('ok');
    expect(res.capped).toBeUndefined();
  });

  it('rejects finish when the last run has an interference, a build error, or a guardrail refusal', async () => {
    const m = installModel([
      reply([run(PLAIN), run(CLASHING), render(), finish()]),
      reply([run(BROKEN), render(), finish()]),
      reply([run('import os\nresult = 1\n'), finish()]),
      reply([run(PLAIN), render(), finish('fine')]),
    ]);
    const res = await runDesigner({ request: 'a box' }, {});
    const t1 = toolResults(m.seen[1]).join('\n');
    expect(t1).toMatch(/did not pass the checks: interferences: body collides with lid/);
    expect(toolResults(m.seen[2]).join('\n')).toMatch(/did not pass the checks: the run failed/);
    expect(toolResults(m.seen[3]).join('\n')).toMatch(/Script guardrail check failed/);
    expect(res.summary).toBe('fine');
    expect(res.script).toBe(PLAIN);
  });

  it('requires pose parameters to default to their range min and to be rendered at max without interference', async () => {
    const m = installModel([
      reply([run(POSED_BAD_DEFAULT), run(POSED_BAD_DEFAULT), render(), finish()]),
      reply([run(POSED), render(), finish()]),
      reply([run(POSED_CLASH_OPEN), render({ lid_open_deg: 90 }), finish()]),
      reply([run(POSED), render({ lid_open_deg: 45 }), finish()]),
      reply([render({ lid_open_deg: 90 }), finish('ok')]),
    ]);
    const res = await runDesigner({ request: 'a box with a lid' }, {});
    expect(toolResults(m.seen[1]).join('\n')).toMatch(/must default to its range min \(0\), but defaults to 30/);
    expect(toolResults(m.seen[2]).join('\n')).toMatch(/must be rendered at its range max \(90\)/);
    // rendering at max with an interference does not count
    expect(toolResults(m.seen[3]).join('\n')).toMatch(/WARNING: interferences detected/);
    expect(toolResults(m.seen[3]).join('\n')).toMatch(/must be rendered at its range max \(90\)/);
    // a mid-range render does not count either; max with no clash does
    expect(toolResults(m.seen[4]).join('\n')).toMatch(/must be rendered at its range max \(90\)/);
    expect(res.summary).toBe('ok');
    expect(res.facts.parts).toHaveLength(2);
  });

  it('rejects a pose parameter without a range', async () => {
    const noRange = body(['width = 40', 'drawer_travel = 0  # slide', 'result = Box(width, 10, 10)']);
    const m = installModel([
      reply([run(noRange), run(noRange), render(), finish()]),
      reply([run(PLAIN), render(), finish('ok')]),
    ]);
    await runDesigner({ request: 'a drawer' }, {});
    expect(toolResults(m.seen[1]).join('\n')).toMatch(/has no range comment/);
  });

  it('rejects a finish that carries a different script', async () => {
    const m = installModel([
      reply([run(PLAIN), run(PLAIN), render(), { name: 'finish', args: { summary: 's', script: `${PLAIN}# edited\n` } }]),
      reply([finish('ok')]),
    ]);
    const res = await runDesigner({ request: 'a box' }, {});
    expect(toolResults(m.seen[1]).join('\n')).toMatch(/script was modified in the finish call/);
    expect(res.summary).toBe('ok');
  });

  it('fills named dimensions from top-level number lines', async () => {
    installModel([reply([run(POSED), run(POSED), render(), render({ lid_open_deg: 90 }), finish()])]);
    const res = await runDesigner({ request: 'a box with a lid' }, {});
    expect(res.facts.dimensions).toEqual([{ name: 'width', value: 40 }]);
    expect(res.facts.span).toEqual([40, 10, 12]);
  });
});

describe('edit mode', () => {
  it('starts from the prior script and the edit, and needs only one run_script', async () => {
    const m = installModel([reply([run(`${PLAIN}# wider\n`), render(), finish('widened')])]);
    const res = await runDesigner({ request: 'a box', priorScript: PLAIN, editRequest: 'make it wider' }, {});
    const first = m.seen[0][1].content as Array<{ text: string }>;
    expect(first[0].text).toContain('make it wider');
    expect(first[0].text).toContain('width = 40  # overall width');
    expect(first[0].text).toMatch(/Keep everything the user did not ask to change/);
    expect(res.summary).toBe('widened');
    expect(res.turns).toBe(1);
  });

  it('can render the prior script before any run_script', async () => {
    const m = installModel([reply([render()]), reply([run(PLAIN), render(), finish('ok')])]);
    await runDesigner({ request: 'a box', priorScript: PLAIN, editRequest: 'x' }, {});
    expect(toolResults(m.seen[1])[0]).toMatch(/Rendered 4 views/);
  });

  it('a first build with one run_script is still rejected', async () => {
    const m = installModel([reply([run(PLAIN), render(), finish()]), reply([run(PLAIN), render(), finish('ok')])]);
    await runDesigner({ request: 'a box' }, {});
    expect(toolResults(m.seen[1]).join('\n')).toMatch(/at least 2 run_script calls/);
  });
});

describe('caps', () => {
  it('stops at the turn cap and returns the last passing script, capped', async () => {
    let n = 0;
    installModel(() => reply([run(`${PLAIN}# v${++n}\n`)]));
    const events: DesignerEvent[] = [];
    const res = await runDesigner({ request: 'a box' }, { onEvent: (e) => events.push(e) });
    expect(res.turns).toBe(MAX_TURNS);
    expect(res.capped).toBe('turns');
    expect(res.failed).toBeUndefined();
    expect(res.script).toBe(`${PLAIN}# v${MAX_TURNS}\n`);
    expect(events.some((e) => e.kind === 'note')).toBe(true);
  });

  it('stops at the cost cap', async () => {
    installModel(() => reply([run(PLAIN)], { outputTokens: 100_000 }));
    const res = await runDesigner({ request: 'a box' }, {});
    expect(res.capped).toBe('cost');
    expect(res.costUsd).toBeGreaterThanOrEqual(MAX_COST_USD);
    expect(res.turns).toBeLessThan(MAX_TURNS);
  });

  it('stops at the wall cap', async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      installModel(() => {
        now += 200_000;
        return reply([run(PLAIN)]);
      });
      const res = await runDesigner({ request: 'a box' }, {});
      expect(res.capped).toBe('wall');
      expect(res.turns).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('sets failed when no script ever passed the checks', async () => {
    installModel(() => reply([run(BROKEN)]));
    const res = await runDesigner({ request: 'a box' }, {});
    expect(res.capped).toBe('turns');
    expect(res.failed).toBe(true);
    expect(res.facts.ok).toBe(false);
    expect(res.facts.error).not.toMatch(/Traceback|\/srv/);
  });

  it('a signal abort ends the loop with the last good script', async () => {
    const ctl = new AbortController();
    let n = 0;
    installModel(() => {
      if (++n === 3) ctl.abort();
      return reply([run(`${PLAIN}# v${n}\n`)]);
    });
    const res = await runDesigner({ request: 'a box' }, { signal: ctl.signal });
    expect(res.turns).toBe(3);
    expect(res.capped).toBeUndefined();
    expect(res.failed).toBeUndefined();
    expect(res.script).toBe(`${PLAIN}# v2\n`);
  });
});

describe('reviewer', () => {
  it('is called after every render, appends its notes, and records flags', async () => {
    const review = vi.fn<ReviewFn>(async () => ({ flags: [flag('major', 'handle is too small')], costUsd: 0.01 }));
    const events: DesignerEvent[] = [];
    const m = installModel([
      reply([run(PLAIN), run(PLAIN), render()]),
      reply([finish('ok')]),
    ]);
    const res = await runDesigner({ request: 'a box' }, { review, onEvent: (e) => events.push(e) });
    expect(review).toHaveBeenCalledTimes(2); // after render + at finish
    const first = review.mock.calls[0][0];
    expect(first.final).toBe(false);
    expect(first.request).toBe('a box');
    expect(first.images.map((i) => i.view)).toEqual(['iso', 'front', 'right', 'top']);
    expect(first.images[0].dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(first.facts.parts).toHaveLength(2);
    expect(review.mock.calls[1][0].final).toBe(true);
    expect(toolResults(m.seen[1]).join('\n')).toMatch(/Independent reviewer notes:\n- \[MAJOR\] handle is too small: it falls over/);
    expect(res.reviewerFlags.map((f) => [f.severity, f.final, f.round])).toEqual([
      ['major', false, 1],
      ['major', true, 2],
    ]);
    expect(res.costUsd).toBeGreaterThan(0.02);
    expect(events.filter((e) => e.kind === 'review')).toHaveLength(2);
    expect(events.some((e) => e.kind === 'step' && e.text === 'Revising after review')).toBe(false);
  });

  it('blocking flags reject finish at most twice, then the finish is accepted and the flags recorded', async () => {
    const review = vi.fn<ReviewFn>(async (i) => ({ flags: i.final ? [flag('blocking')] : [], costUsd: 0 }));
    const m = installModel([
      reply([run(PLAIN), run(PLAIN), render(), finish('one')]),
      reply([finish('two')]),
      reply([finish('three')]),
      reply([finish('four')]),
    ]);
    const res = await runDesigner({ request: 'a box' }, { review });
    const results = toolResults(m.seen[m.seen.length - 1]).filter((t) => /rejected by the independent reviewer/.test(t));
    expect(results).toHaveLength(2);
    expect(res.turns).toBe(3);
    expect(res.summary).toBe('three');
    expect(res.reviewerFlags.filter((f) => f.final && f.severity === 'blocking')).toHaveLength(3);
    expect(res.capped).toBeUndefined();
  });

  it('a failing reviewer does not stop the build', async () => {
    const review: ReviewFn = async () => {
      throw new Error('reviewer down');
    };
    installModel([reply([run(PLAIN), run(PLAIN), render(), finish('ok')])]);
    const res = await runDesigner({ request: 'a box' }, { review });
    expect(res.summary).toBe('ok');
    expect(res.reviewerFlags).toEqual([]);
  });

  it('without a reviewer the tool result has no reviewer notes', async () => {
    const m = installModel([reply([run(PLAIN), run(PLAIN), render()]), reply([finish('ok')])]);
    await runDesigner({ request: 'a box' }, {});
    expect(toolResults(m.seen[1]).join('\n')).not.toMatch(/reviewer notes/);
  });
});

describe('guardrail', () => {
  it('checks every script before runBrep, for run_script and render', async () => {
    const huge = `${PLAIN}# ${'x'.repeat(MAX_SCRIPT_BYTES)}\n`;
    const m = installModel([
      reply([run(huge), run('open("/etc/passwd")\nresult = 1\n'), render()]),
      reply([run(PLAIN), render({ width: 50 }), finish()]),
    ]);
    await runDesigner({ request: 'a box' }, { review: undefined });
    // brepFor asserts the guardrail passed for every script that reached the runner
    for (const [script] of vi.mocked(runBrep).mock.calls) expect(checkPythonScript(script).ok).toBe(true);
    expect(vi.mocked(runBrep).mock.calls.some(([s]) => s === huge)).toBe(false);
    expect(toolResults(m.seen[1]).join('\n')).toMatch(/guardrail check failed: script too large/);
    expect(toolResults(m.seen[1]).join('\n')).toMatch(/Nothing to render yet/);
  });

  it('passes the signal and a bounded timeout to the runner', async () => {
    installModel([reply([run(PLAIN), run(PLAIN), render(), finish()])]);
    await runDesigner({ request: 'a box' }, {});
    for (const [, opts] of vi.mocked(runBrep).mock.calls) {
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      expect(opts?.timeoutMs).toBeLessThanOrEqual(120_000);
    }
  });
});

describe('events', () => {
  it('carry fixed phrases only: no model text, code, summaries or tracebacks', async () => {
    const events: DesignerEvent[] = [];
    const secret = 'SECRET_MODEL_TEXT';
    installModel([
      reply([run(BROKEN), run(`${PLAIN}# ${secret}\n`), render()], { text: secret }),
      reply([finish(`${secret} summary`)]),
    ]);
    await runDesigner({ request: `${secret} request` }, { onEvent: (e) => events.push(e) });
    const dump = JSON.stringify(events);
    expect(dump).not.toMatch(/SECRET|Traceback|ValueError|Box\(|import |result =/);
    const steps = events.filter((e) => e.kind === 'step').map((e) => (e as { text: string }).text);
    expect(steps).toEqual([
      'The model did not build; revising',
      'Built the model (2 parts)',
      'Rendered 4 views',
      'Finished',
    ]);
  });

  it('a throwing listener does not end the build', async () => {
    installModel([reply([run(PLAIN), run(PLAIN), render(), finish('ok')])]);
    const res = await runDesigner({ request: 'a box' }, { onEvent: () => { throw new Error('ui'); } });
    expect(res.summary).toBe('ok');
  });

  it('invokes the designer model with nostream tag', async () => {
    const m = installModel([reply([run(PLAIN), run(PLAIN), render(), finish()])]);
    await runDesigner({ request: 'a box' }, {});
    expect(m.invoke).toHaveBeenCalled();
    const options = m.invoke.mock.calls[0]?.[1] as { tags?: string[] } | undefined;
    expect(options?.tags).toContain('nostream');
  });
});

describe('prompt caching', () => {
  it('keeps one rolling breakpoint on the newest message and the system prompt cached', async () => {
    const m = installModel([reply([run(PLAIN), run(PLAIN), render()]), reply([finish('ok')])]);
    await runDesigner({ request: 'a box' }, {});
    const lastMsgs = m.seen[1];
    const breakpoints = lastMsgs.filter((x) => Array.isArray(x.content) && (x.content as Array<{ cache_control?: unknown }>).some((b) => b.cache_control));
    expect(breakpoints).toHaveLength(2); // system + newest
    expect(breakpoints[0]).toBe(lastMsgs[0]);
    expect(breakpoints[1]).toBe(lastMsgs[lastMsgs.length - 1]);
  });
});

describe('body-only model interface', () => {
  it('the model is shown the body only', async () => {
    const priorBody = 'width = 40\nresult = Box(width, 10, 10)\n';
    const priorScript = `${GENERATED_PRELUDE}\n\n${PRELUDE_SENTINEL}\n\n${priorBody}`;

    // New design
    const mNew = installModel([reply([finish('ok')])]);
    await runDesigner({ request: 'a box' }, {});
    const newMsgText = (mNew.seen[0][1].content as Array<{ text: string }>)[0].text;
    expect(newMsgText).not.toContain(PRELUDE_SENTINEL);
    expect(newMsgText).not.toContain('from build123d import *');
    expect(newMsgText).not.toContain('def _fuse');

    // Edit design
    const mEdit = installModel([reply([finish('ok')])]);
    await runDesigner({ request: 'a box', priorScript, editRequest: 'wider' }, {});
    const editMsgText = (mEdit.seen[0][1].content as Array<{ text: string }>)[0].text;
    expect(editMsgText).not.toContain(PRELUDE_SENTINEL);
    expect(editMsgText).not.toContain('from build123d import *');
    expect(editMsgText).not.toContain('def _fuse');
    expect(editMsgText).toContain('width = 40');
  });

  it('finish accepts its own body', async () => {
    const bodyCode = 'width = 40\nresult = Box(width, 10, 10)\n';
    installModel([
      reply([run(bodyCode), run(bodyCode), render(), { name: 'finish', args: { summary: 'finished', script: bodyCode } }]),
    ]);
    const res = await runDesigner({ request: 'a box' }, {});
    expect(res.failed).toBeUndefined();
    expect(res.summary).toBe('finished');
  });

  it('a body-only first run passes', async () => {
    const bodyCode = 'width = 40\nresult = Box(width, 10, 10)\n';
    installModel([
      reply([run(bodyCode), run(bodyCode), render(), finish()]),
    ]);
    const res = await runDesigner({ request: 'a box' }, {});
    const expectedScript = withGeneratedPrelude(bodyCode);
    expect(vi.mocked(runBrep).mock.calls[0]?.[0]).toBe(expectedScript);
    expect(checkPythonScript(expectedScript).ok).toBe(true);
    expect(res.script).toBe(expectedScript);
  });

  it('prompt contains the exact prelude contract sentence', () => {
    expect(DESIGNER_SYSTEM_PROMPT).toContain(
      'Write only the design code; the tool adds the prelude; `_round`/`_bevel` are available.'
    );
  });

  it('an attachment reaches the designer and the reviewer as an image block', async () => {
    let capturedReviewInput: ReviewInput | null = null;
    const fakeReview: ReviewFn = async (input) => {
      capturedReviewInput = input;
      return { flags: [], costUsd: 0 };
    };

    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const m = installModel([
      reply([run(PLAIN), run(PLAIN), render()]),
      reply([finish('ok')]),
    ]);

    await runDesigner(
      {
        request: 'a box with reference',
        attachments: [{ mediaType: 'image/png', base64: b64 }],
      },
      { review: fakeReview }
    );

    const firstHumanMsg = m.seen[0][1];
    expect(Array.isArray(firstHumanMsg.content)).toBe(true);
    const content = firstHumanMsg.content as Array<{ type: string; text?: string; [k: string]: unknown }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${b64}` },
    });
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain("The images above are the user's reference images.");

    expect(capturedReviewInput).not.toBeNull();
    expect(capturedReviewInput!.images[0]).toEqual({
      view: 'reference:1',
      dataUrl: `data:image/png;base64,${b64}`,
    });
  });

  it('run-designer labels markup and reference images per kind', async () => {
    let capturedReviewInput: ReviewInput | null = null;
    const fakeReview: ReviewFn = async (input) => {
      capturedReviewInput = input;
      return { flags: [], costUsd: 0 };
    };

    installModel([
      reply([run(PLAIN), run(PLAIN), render()]),
      reply([finish('ok')]),
    ]);

    await runDesigner(
      {
        request: 'a box with attachments',
        attachments: [
          { mediaType: 'image/png', base64: 'b64_1', kind: 'markup' },
          { mediaType: 'image/png', base64: 'b64_2', kind: 'reference' },
          { mediaType: 'image/png', base64: 'b64_3', kind: 'markup' },
        ],
      },
      { review: fakeReview }
    );

    expect(capturedReviewInput).not.toBeNull();
    const views = capturedReviewInput!.images.map((img) => img.view);
    expect(views).toContain('markup:1');
    expect(views).toContain('reference:1');
    expect(views).toContain('markup:2');
    expect(capturedReviewInput!.images[0].view).toBe('markup:1');
    expect(capturedReviewInput!.images[1].view).toBe('reference:1');
    expect(capturedReviewInput!.images[2].view).toBe('markup:2');
  });

  it('no attachments → text only', async () => {
    const m = installModel([reply([finish('ok')])]);
    await runDesigner({ request: 'a box' }, {});
    const firstHumanMsg = m.seen[0][1];
    expect(Array.isArray(firstHumanMsg.content)).toBe(true);
    const content = firstHumanMsg.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    expect(content[0].text).not.toContain('reference images');
  });

  it('a designer refusal sets stop and maps to REFUSAL', async () => {
    const refusalReply = new AIMessage({
      content: 'I cannot help with that.',
      response_metadata: { stop_reason: 'refusal' },
    });
    installModel([refusalReply]);

    const result = await runDesigner({ request: 'make something unsafe' }, {});
    expect(result.stop).toBe('refusal');

    const node = createDesignerNode({
      runDesigner: vi.fn().mockResolvedValue(result),
    });
    const state = {
      messages: [new HumanMessage('make something unsafe')],
    } as never;
    const res = await node(state);
    expect(res.outcome?.replyKind).toBe('error');
    expect(res.outcome?.replyMarkdown).toBe(REFUSAL);
  });

  it('the designer budget fits inside the remaining deadline', async () => {
    const now = 1_000_000;
    expect(designerWallBudgetMs(now + 900_000, now)).toBe(MAX_WALL_MS);
    expect(designerWallBudgetMs(now + 400_000, now)).toBe(250_000);
    expect(designerWallBudgetMs(now + 160_000, now)).toBe(MIN_DESIGNER_WALL_MS);
    expect(designerWallBudgetMs(undefined, now)).toBe(MAX_WALL_MS);

    let curr = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => curr);
    try {
      installModel(() => {
        curr += 40_000;
        return reply([run(PLAIN)]);
      });
      const res = await runDesigner({ request: 'a box' }, { wallMs: 50_000 });
      expect(res.capped).toBe('wall');
    } finally {
      spy.mockRestore();
    }
  });

  it('run-designer emits a cost event after every model and reviewer call', async () => {
    const events: DesignerEvent[] = [];
    installModel([
      reply([run(PLAIN), render()]),
      reply([run(PLAIN)]),
    ]);
    const mockReview: ReviewFn = vi.fn().mockResolvedValue({
      flags: [],
      costUsd: 0.05,
    });

    const result = await runDesigner(
      { request: 'a box' },
      {
        review: mockReview,
        onEvent: (e) => events.push(e),
      }
    );

    const costEvents = events.filter((e): e is { kind: 'cost'; usd: number } => e.kind === 'cost');
    expect(costEvents.length).toBe(3);
    const sum = costEvents.reduce((acc, ev) => acc + ev.usd, 0);
    expect(Number(sum.toFixed(6))).toBe(Number(result.costUsd.toFixed(6)));
  });
});
