import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import { getChatModel, isAbortOrTimeout } from './model-provider';
import { invokeWithToolRound } from './tool-round';
import {
  structuredFor,
  ArchitectPlanSchema,
  SheetReviewSchema,
  VisualCritiqueSchema,
  normalizeSeverity,
  parseArchitectPlan,
  parseSheetReview,
  parseVisualCritique,
  parseStringifiedFields,
  UnusableReplyError,
} from './llm-schemas';
import { AssemblySpecSchema, variantSpecRequestSchema } from './assembly-spec';
import { getFunctionalCadModuleTool } from './engineering-tools';
import { reply, textStream, toolUseStream, withFakeClient, type Body } from './__fixtures__/fake-anthropic';

// Fixes from the blind review of the native Messages API switch (n1-review.md).

const saved = { ...process.env };
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  for (const k of ['CADAI_MODEL', 'CADAI_MAX_TOKENS', 'CADAI_MODEL_TIMEOUT_MS', 'CADAI_THINKING', 'CADAI_EFFORT']) delete process.env[k];
});
afterEach(() => {
  process.env = { ...saved };
});

const TOOL = getFunctionalCadModuleTool.name;

describe('1. drafter / repair tool round', () => {
  it('the follow-up request after a tool result defines the tools, with tool_choice none', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const bodies = withFakeClient(model, (_body, call) =>
      call === 0
        ? reply([
            { type: 'text', text: 'Fetching the fastener table.' },
            { type: 'tool_use', id: 'toolu_1', name: TOOL, input: { moduleKey: 'fastener_hardware' } },
          ])
        : reply([{ type: 'text', text: '```openscad\ncube(10);\n```' }])
    );

    const res = await invokeWithToolRound(model, [new HumanMessage('draft it')]);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools.map((t: Body) => t.name)).toEqual([TOOL]);
    expect(bodies[0].tool_choice).toBeUndefined();
    // The second request carries tool_use / tool_result blocks, so it must define the tools.
    expect(bodies[1].tools.map((t: Body) => t.name)).toEqual([TOOL]);
    expect(bodies[1].tool_choice).toEqual({ type: 'none' });
    const [user, assistant, toolResult] = bodies[1].messages;
    expect(user).toEqual({ role: 'user', content: 'draft it' });
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toContainEqual(expect.objectContaining({ type: 'tool_use', id: 'toolu_1', name: TOOL }));
    expect(toolResult.role).toBe('user');
    expect(toolResult.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(res.content).toBe('```openscad\ncube(10);\n```');
  });

  it('every tool_use gets a tool_result: an unknown tool and bad arguments return error results', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const bodies = withFakeClient(model, (_body, call) =>
      call === 0
        ? reply([
            { type: 'tool_use', id: 'toolu_a', name: 'web_search', input: { q: 'm3' } },
            { type: 'tool_use', id: 'toolu_b', name: TOOL, input: { moduleKey: 'no_such_module' } },
          ])
        : reply([{ type: 'text', text: 'done' }])
    );

    await invokeWithToolRound(model, [new HumanMessage('draft it')]);

    const results = bodies[1].messages.at(-1).content as Body[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
    expect(JSON.stringify(results[0].content)).toContain('Unknown tool \\"web_search\\"');
    expect(JSON.stringify(results[1].content)).toContain('Tool error');
  });

  it('a reply without tool calls is returned after one request', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const bodies = withFakeClient(model, () => reply([{ type: 'text', text: 'cube(1);' }]));
    const res = await invokeWithToolRound(model, [new HumanMessage('draft it')]);
    expect(bodies).toHaveLength(1);
    expect(res.content).toBe('cube(1);');
  });
});

describe('2. enums in planner, reviewer and critic structured output', () => {
  it('the schema sent as output_config.format keeps its enums (decode-time enforcement)', async () => {
    const cases = [
      { schema: SheetReviewSchema, pick: (s: Body) => s.properties.findings.items.properties.severity.enum, want: ['minor', 'major'], reply: { matchesRequest: true, findings: [] } },
      { schema: VisualCritiqueSchema, pick: (s: Body) => s.properties.findings.items.properties.severity.enum, want: ['minor', 'major'], reply: { matchesIntent: true, findings: [] } },
      {
        schema: ArchitectPlanSchema,
        pick: (s: Body) => [s.properties.variants.items.properties.id.enum, s.properties.recommendedId.enum],
        want: [['A', 'B', 'C'], ['A', 'B', 'C']],
        reply: { brief: '', assumptions: [], openQuestions: [], variants: [{ id: 'A', name: 'n', idea: 'i' }], recommendedId: 'A' },
      },
    ];
    for (const c of cases) {
      const model = getChatModel('claude-haiku-5.5');
      const bodies = withFakeClient(model, () => reply([{ type: 'text', text: JSON.stringify(c.reply) }]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await (structuredFor(model, 'claude-haiku-5.5', c.schema) as any).invoke([new HumanMessage('x')]);
      expect(out).toEqual(c.reply);
      expect(c.pick(bodies[0].output_config.format.schema)).toEqual(c.want);
      expect(bodies[0].output_config.effort).toBe('high');
    }
  });

  it('severity is read case-insensitively, and anything not clearly minor counts as major (fail closed)', () => {
    for (const s of ['minor', 'Minor', ' MINOR ', 'low', 'cosmetic', 'nit']) expect(normalizeSeverity(s), s).toBe('minor');
    for (const s of ['major', 'Major', 'high', 'critical', 'severe', 'medium', 'unknown', '', undefined, 3]) expect(normalizeSeverity(s), String(s)).toBe('major');
  });

  it('parseSheetReview normalises severities, and a reviewer "Major" or "high" finding fails the variant', () => {
    const review = parseSheetReview({
      matchesRequest: true,
      findings: [
        { issue: 'arm missing', severity: 'Major' },
        { issue: 'hole off', severity: 'high' },
        { issue: 'lip short', severity: 'Minor' },
        { issue: 'odd', severity: 'whatever' },
      ],
    });
    expect(review?.findings.map((f) => f.severity)).toEqual(['major', 'major', 'minor', 'major']);
    expect(review?.findings.some((f) => f.severity === 'major')).toBe(true);
  });

  it('an unusable review or critique is null (the caller asks again once, then reports it unavailable)', () => {
    expect(parseSheetReview({ findings: [] })).toBeNull();
    expect(parseSheetReview('nope')).toBeNull();
    expect(parseSheetReview({ matchesRequest: true, findings: [{ severity: 'major' }] })).toBeNull();
    expect(parseVisualCritique({ findings: [] })).toBeNull();
    expect(parseVisualCritique({ matchesIntent: false, findings: [{ issue: 'x', severity: 'MAJOR', view: 'front' }] })).toEqual({
      matchesIntent: false,
      findings: [{ issue: 'x', severity: 'major', view: 'front' }],
    });
  });

  it('parseArchitectPlan reads variant ids case-insensitively and still rejects an unknown id', () => {
    const plan = parseArchitectPlan({
      brief: 'b',
      assumptions: null,
      openQuestions: [],
      variants: [{ id: 'a', name: 'n', idea: 'i' }, { id: ' b ', name: 'n2', idea: 'i2' }],
      recommendedId: 'b',
    });
    expect(plan.success).toBe(true);
    expect(plan.data?.variants.map((v) => v.id)).toEqual(['A', 'B']);
    expect(plan.data?.recommendedId).toBe('B');
    expect(parseArchitectPlan({ variants: [{ id: 'D', name: 'n', idea: 'i' }] }).success).toBe(false);
  });
});

describe('3. a reply cut off at max_tokens or refused is a failed attempt, never a partial spec', () => {
  const partial = { assemblyName: 'x', components: [{ name: 'a', description: 'part' }] };

  it('variant spec, non-streamed: tool_use with an unusable stop_reason throws UnusableReplyError (a failed attempt)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const stop of ['max_tokens', 'refusal', 'pause_turn', 'model_context_window_exceeded'] as const) {
      const model = getChatModel('claude-haiku-5.5');
      withFakeClient(model, () => reply([{ type: 'tool_use', id: 'toolu_t', name: 'AssemblySpec', input: partial }], stop));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bound = structuredFor(model, 'claude-haiku-5.5', variantSpecRequestSchema(), { name: 'AssemblySpec' }) as any;
      const err = await bound.invoke([new HumanMessage('x')]).catch((e: unknown) => e);
      expect(err, stop).toBeInstanceOf(UnusableReplyError);
      expect((err as UnusableReplyError).stop).toBe(stop);
    }
    // The same input with a normal stop is returned (control).
    const model = getChatModel('claude-haiku-5.5');
    withFakeClient(model, () => reply([{ type: 'tool_use', id: 'toolu_t', name: 'AssemblySpec', input: partial }]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await (structuredFor(model, 'claude-haiku-5.5', variantSpecRequestSchema(), { name: 'AssemblySpec' }) as any).invoke([new HumanMessage('x')]);
    expect(ok).toEqual(partial);
    warn.mockRestore();
  });

  it('variant spec, streamed (as inside the graph) or with includeRaw: a max_tokens reply never yields a spec', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const streamed = getChatModel('claude-haiku-5.5');
    withFakeClient(streamed, () => toolUseStream('AssemblySpec', JSON.stringify(partial), 'max_tokens'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = structuredFor(streamed, 'claude-haiku-5.5', variantSpecRequestSchema(), { name: 'AssemblySpec' }) as any;
    const drain = async () => {
      for await (const chunk of await s.stream([new HumanMessage('x')])) void chunk;
    };
    await expect(drain()).rejects.toBeInstanceOf(UnusableReplyError);

    // includeRaw (the eval gateway): LangChain's parser fallback reports parsed: null.
    const raw = getChatModel('claude-haiku-5.5');
    withFakeClient(raw, () => reply([{ type: 'tool_use', id: 'toolu_t', name: 'AssemblySpec', input: partial }], 'max_tokens'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = structuredFor(raw, 'claude-haiku-5.5', variantSpecRequestSchema(), { name: 'AssemblySpec', includeRaw: true }) as any;
    const out = (await r.invoke([new HumanMessage('x')])) as Body;
    expect(out.parsed ?? null).toBeNull();
    warn.mockRestore();
  });

  it('json_schema routes throw on max_tokens or refusal even when the text parses', async () => {
    for (const stop of ['max_tokens', 'refusal']) {
      const model = getChatModel('claude-haiku-5.5');
      withFakeClient(model, () => reply([{ type: 'text', text: JSON.stringify({ matchesRequest: true, findings: [] }) }], stop));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bound = structuredFor(model, 'claude-haiku-5.5', SheetReviewSchema) as any;
      await expect(bound.invoke([new HumanMessage('x')]), stop).rejects.toThrow(`stop_reason ${stop}`);
    }
  });

  it('json_schema routes still stream progressively parsed objects', async () => {
    const model = getChatModel('claude-haiku-5.5');
    withFakeClient(model, () => textStream(['{"matchesRequest": true, "find', 'ings": [{"issue": "a", "sev', 'erity": "minor"}]}']));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bound = structuredFor(model, 'claude-haiku-5.5', SheetReviewSchema) as any;
    const snaps: unknown[] = [];
    for await (const s of await bound.stream([new HumanMessage('x')])) snaps.push(s);
    expect(snaps.length).toBeGreaterThan(1);
    expect(snaps.at(-1)).toEqual({ matchesRequest: true, findings: [{ issue: 'a', severity: 'minor' }] });
  });
});

describe('5. aborts and timeouts are not retried; overloads are', () => {
  class FakeAbort extends Error {
    constructor() {
      super('Request was aborted.');
    }
  }
  const overloaded = () => Object.assign(new Error('529 {"type":"error","error":{"type":"overloaded_error"}}'), { status: 529 });

  it('recognises the SDK abort and timeout errors', () => {
    expect(isAbortOrTimeout(new FakeAbort())).toBe(true);
    expect(isAbortOrTimeout(new Error('Request timed out.'))).toBe(true);
    expect(isAbortOrTimeout(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortOrTimeout(overloaded())).toBe(false);
  });

  it('an aborted call is sent once', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const bodies = withFakeClient(model, () => Promise.reject(new FakeAbort()));
    await expect(model.invoke([new HumanMessage('x')])).rejects.toThrow('Request was aborted.');
    expect(bodies).toHaveLength(1);
  });

  it('a timed-out call is sent once', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const bodies = withFakeClient(model, () => Promise.reject(new Error('Request timed out.')));
    await expect(model.invoke([new HumanMessage('x')])).rejects.toThrow('Request timed out.');
    expect(bodies).toHaveLength(1);
  });

  it('a 529 overload is retried once (maxRetries 1)', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const bodies = withFakeClient(model, (_b, call) => (call === 0 ? Promise.reject(overloaded()) : reply([{ type: 'text', text: 'ok' }])));
    const res = await model.invoke([new HumanMessage('x')]);
    expect(res.content).toBe('ok');
    expect(bodies).toHaveLength(2);
  }, 15_000);

  it('a 400 is not retried', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const bodies = withFakeClient(model, () => Promise.reject(Object.assign(new Error('400 bad request'), { status: 400 })));
    await expect(model.invoke([new HumanMessage('x')])).rejects.toThrow('400');
    expect(bodies).toHaveLength(1);
  });
});

describe('6. element-level JSON parsing only where the schema expects objects', () => {
  const FIELDS = ['components', 'parameters', 'derived', 'relations', 'guides', 'jointContracts', 'assumptions', 'openQuestions'];

  it('every field whose string elements are parsed has object elements in AssemblySpecSchema', () => {
    const shape = AssemblySpecSchema.shape as Record<string, z.ZodType>;
    for (const field of FIELDS) {
      // A plain string element must fail the schema, so parsing a JSON-object string can only help.
      const withString = shape[field].safeParse(['plain text']);
      expect(withString.success, field).toBe(false);
    }
  });

  it('string elements that are not JSON objects stay strings', () => {
    const out = parseStringifiedFields({ assumptions: ['plain text', '"quoted"', '[1]'], openQuestions: ['Why?'] });
    expect(out).toEqual({ assumptions: ['plain text', '"quoted"', '[1]'], openQuestions: ['Why?'] });
  });
});
