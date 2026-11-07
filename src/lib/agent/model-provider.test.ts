import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage } from '@langchain/core/messages';
import { anthropicModelId, getChatModel, thinkingFor } from './model-provider';
import { DEFAULT_MODEL, MODELS, isOfferedModel, isVisionModel } from './models';
import { cachedSystemMessage, systemPromptFor } from './system-prompt';
import { structuredFor, ArchitectPlanSchema } from './llm-schemas';
import { variantSpecRequestSchema } from './assembly-spec';
import { getFunctionalCadModuleTool } from './engineering-tools';
import { reply, textStream, withFakeClient, type Body } from './__fixtures__/fake-anthropic';

const saved = { ...process.env };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  for (const k of ['CADAI_MODEL', 'CADAI_MAX_TOKENS', 'CADAI_MODEL_TIMEOUT_MS', 'CADAI_THINKING', 'CADAI_EFFORT']) delete process.env[k];
});

afterEach(() => {
  process.env = { ...saved };
});

describe('getChatModel', () => {
  it('builds a native ChatAnthropic under the Anthropic model id', () => {
    const model = getChatModel('claude-sonnet-5.5');
    expect(model).toBeInstanceOf(ChatAnthropic);
    expect(model.model).toBe('claude-sonnet-5-5');
    expect(model.apiUrl).toBeUndefined();
  });

  it('never sends a temperature: Claude 5.5 rejects non-default values', () => {
    expect(getChatModel('claude-haiku-5.5').invocationParams({}).temperature).toBeUndefined();
    expect(getChatModel('claude-opus-5.5', { temperature: 0.6 }).invocationParams({}).temperature).toBeUndefined();
  });

  it('defaults to Haiku 5.5, and CADAI_MODEL overrides it', () => {
    expect(getChatModel().model).toBe('claude-haiku-5-5');
    process.env.CADAI_MODEL = 'claude-sonnet-5.5';
    expect(getChatModel().model).toBe('claude-sonnet-5-5');
  });

  it('CADAI_MODEL is ignored with a warning when not an offered model', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CADAI_MODEL = 'gpt-6-sol';
    expect(getChatModel().model).toBe('claude-haiku-5-5');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CADAI_MODEL "gpt-6-sol" is not an offered model'));
    warnSpy.mockRestore();
  });

  it('sets maxTokens to 32000 with thinking off, 64000 with thinking on, and CADAI_MAX_TOKENS overrides both', () => {
    expect(getChatModel('claude-haiku-5.5').maxTokens).toBe(32000);
    // Sonnet and Opus think even with CADAI_THINKING=off, so max_tokens covers it.
    expect(getChatModel('claude-sonnet-5.5').maxTokens).toBe(64000);
    expect(getChatModel('claude-opus-5.5').maxTokens).toBe(64000);
    process.env.CADAI_THINKING = 'adaptive';
    expect(getChatModel('claude-haiku-5.5').maxTokens).toBe(64000);
    process.env.CADAI_MAX_TOKENS = '16000';
    expect(getChatModel('claude-haiku-5.5').maxTokens).toBe(16000);
    expect(getChatModel('claude-opus-5.5').maxTokens).toBe(16000);
  });

  it('times out after 240 s by default (CADAI_MODEL_TIMEOUT_MS overrides) and retries once', () => {
    const model = getChatModel('claude-haiku-5.5');
    expect(model.clientOptions.timeout).toBe(240_000);
    expect((model.caller as unknown as { maxRetries: number }).maxRetries).toBe(1);
    process.env.CADAI_MODEL_TIMEOUT_MS = '90000';
    expect(getChatModel('claude-haiku-5.5').clientOptions.timeout).toBe(90_000);
  });

  it('needs only ANTHROPIC_API_KEY, and says so when it is missing', () => {
    expect(() => getChatModel()).not.toThrow();
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getChatModel()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('maps app slugs to Anthropic ids', () => {
    expect(anthropicModelId('claude-opus-5.5')).toBe('claude-opus-5-5');
  });
});

describe('thinking and effort', () => {
  const sent = (slug: string) => {
    const p = getChatModel(slug).invocationParams({});
    return { thinking: p.thinking, effort: p.output_config?.effort };
  };

  it('defaults to thinking disabled at effort high on Haiku 5.5', () => {
    expect(sent('claude-haiku-5.5')).toEqual({ thinking: { type: 'disabled' }, effort: 'high' });
  });

  it('CADAI_EFFORT sets the effort', () => {
    process.env.CADAI_EFFORT = 'low';
    expect(sent('claude-haiku-5.5')).toEqual({ thinking: { type: 'disabled' }, effort: 'low' });
    process.env.CADAI_EFFORT = 'medium';
    expect(sent('claude-haiku-5.5')).toEqual({ thinking: { type: 'disabled' }, effort: 'medium' });
  });

  it('CADAI_THINKING=adaptive turns adaptive thinking on at the configured effort, on every model', () => {
    process.env.CADAI_THINKING = 'adaptive';
    process.env.CADAI_EFFORT = 'medium';
    for (const slug of ['claude-haiku-5.5', 'claude-sonnet-5.5', 'claude-opus-5.5']) {
      expect(sent(slug)).toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' });
    }
  });

  it('Sonnet 5.5 and Opus 5.5 reject disabled thinking, so "off" runs adaptive at effort low there', () => {
    process.env.CADAI_EFFORT = 'high';
    expect(sent('claude-sonnet-5.5')).toEqual({ thinking: { type: 'adaptive' }, effort: 'low' });
    expect(sent('claude-opus-5.5')).toEqual({ thinking: { type: 'adaptive' }, effort: 'low' });
    expect(thinkingFor('claude-haiku-5-5', 'off', 'high')).toEqual({ thinking: { type: 'disabled' }, effort: 'high' });
  });

  it('an unknown CADAI_THINKING or CADAI_EFFORT falls back to the default with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CADAI_THINKING = 'max';
    process.env.CADAI_EFFORT = 'xhigh';
    expect(sent('claude-haiku-5.5')).toEqual({ thinking: { type: 'disabled' }, effort: 'high' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CADAI_THINKING "max"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CADAI_EFFORT "xhigh"'));
    warnSpy.mockRestore();
  });
});

describe('requests on the wire (fake Anthropic client)', () => {
  it('sends the system prompt as a cached block, with thinking, effort and max_tokens', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const bodies = withFakeClient(model, () => reply([{ type: 'text', text: 'ok' }]));
    const system = systemPromptFor('variant');
    const res = await model.invoke([cachedSystemMessage(system), new HumanMessage('a 60 mm cube')]);

    expect(res.content).toBe('ok');
    const body = bodies[0];
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(32000);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.temperature).toBeUndefined();
    expect(body.system).toEqual([{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]);
    expect(body.messages).toEqual([{ role: 'user', content: 'a 60 mm cube' }]);
  });

  it('every node system prompt is a cached block', () => {
    for (const node of ['planner', 'variant', 'drafter', 'repair', 'critic', 'reviewer', 'build'] as const) {
      const msg = cachedSystemMessage(systemPromptFor(node));
      expect(msg.content).toEqual([{ type: 'text', text: systemPromptFor(node), cache_control: { type: 'ephemeral' } }]);
    }
  });

  it('drafter bindTools: sends the tool natively and parses its tool calls', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const bodies = withFakeClient(model, () =>
      reply([
        { type: 'text', text: 'Looking up the module.' },
        { type: 'tool_use', id: 'toolu_1', name: getFunctionalCadModuleTool.name, input: { moduleKey: 'fastener_hardware' } },
      ])
    );
    const res = await model.bindTools([getFunctionalCadModuleTool]).invoke([new HumanMessage('draft it')]);

    expect(bodies[0].tools.map((t: { name: string }) => t.name)).toEqual([getFunctionalCadModuleTool.name]);
    expect(bodies[0].tools[0].input_schema).toBeDefined();
    expect(bodies[0].tool_choice).toBeUndefined();
    expect(res.tool_calls).toEqual([
      expect.objectContaining({ id: 'toolu_1', name: getFunctionalCadModuleTool.name, args: { moduleKey: 'fastener_hardware' } }),
    ]);
  });

  it('variant spec: binds the AssemblySpec tool with tool_choice auto (never forced) and returns the repaired spec', async () => {
    for (const slug of ['claude-haiku-5.5', 'claude-sonnet-5.5', 'claude-opus-5.5']) {
      const model = getChatModel(slug);
      const spec = {
        assemblyName: 'plate',
        components: [
          {
            name: 'plate',
            description: 'wall plate',
            localExtents: ['plate_w', 'wall', 'plate_h'],
            position: [0, 0, 0],
            shape: { kind: 'box' },
            holes: [{ d: 4, axis: 'y', at: ['hole_left_x', 'hole_top_z'], note: '' }],
          },
        ],
      };
      const bodies = withFakeClient(model, () =>
        reply([
          { type: 'text', text: 'One plate, two holes.' },
          { type: 'tool_use', id: 'toolu_2', name: 'AssemblySpec', input: spec },
        ])
      );
      const bound = structuredFor(model, slug, variantSpecRequestSchema(), { name: 'AssemblySpec', strict: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = (await (bound as any).invoke([new HumanMessage('a wall plate')])) as Body;

      expect(bodies[0].tool_choice).toEqual({ type: 'auto' });
      expect(bodies[0].tools).toHaveLength(1);
      expect(bodies[0].tools[0].name).toBe('AssemblySpec');
      expect(bodies[0].tools[0].strict).toBeUndefined();
      expect(parsed.components[0].holes[0]).toEqual({ d: 4, axis: 'y', at: ['hole_left_x', 'wall', 'hole_top_z'] });
    }
  });

  it('planner, reviewer and critic use native structured output (output_config.format), keeping the effort', async () => {
    for (const [slug, effort] of [['claude-haiku-5.5', 'high'], ['claude-sonnet-5.5', 'low']] as const) {
      const model = getChatModel(slug);
      const plan = { brief: 'b', assumptions: [], openQuestions: [], variants: [{ id: 'A', name: 'Cube', idea: 'a cube' }], recommendedId: 'A' };
      const bodies = withFakeClient(model, () => reply([{ type: 'text', text: JSON.stringify(plan) }]));
      const bound = structuredFor(model, slug, ArchitectPlanSchema, { name: 'ArchitectPlan', strict: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = await (bound as any).invoke([new HumanMessage('a cube')]);

      expect(parsed).toEqual(plan);
      expect(bodies[0].tools).toBeUndefined();
      expect(bodies[0].tool_choice).toBeUndefined();
      expect(bodies[0].output_config.effort).toBe(effort);
      expect(bodies[0].output_config.format.type).toBe('json_schema');
      expect(Object.keys(bodies[0].output_config.format.schema.properties)).toEqual(
        expect.arrayContaining(['brief', 'variants', 'recommendedId'])
      );
    }
  });

  it('structured output still streams progressively parsed objects', async () => {
    const model = getChatModel('claude-haiku-5.5');
    const json = JSON.stringify({ brief: 'A cube with a hole', assumptions: [], openQuestions: [], variants: [{ id: 'A', name: 'Cube', idea: 'x' }], recommendedId: 'A' });
    const pieces = json.match(/.{1,12}/g) as string[];
    const bodies = withFakeClient(model, () => textStream(pieces));
    const bound = structuredFor(model, 'claude-haiku-5.5', ArchitectPlanSchema, { name: 'ArchitectPlan', strict: true });

    const snapshots: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const partial of await (bound as any).stream([new HumanMessage('a cube')])) snapshots.push(partial);

    expect(bodies[0].stream).toBe(true);
    expect(snapshots.length).toBeGreaterThan(3);
    expect(snapshots.at(-1)).toEqual(JSON.parse(json));
    // An early snapshot is a strict prefix of the final object: the brief arrives before the variants.
    expect(snapshots.some((s) => (s as { brief?: string }).brief !== undefined && (s as { variants?: unknown }).variants === undefined)).toBe(true);
  });
});

describe('model catalogue', () => {
  it('offers Haiku (default), Sonnet and Opus only', () => {
    expect(MODELS.map((m) => m.slug)).toEqual(['claude-haiku-5.5', 'claude-sonnet-5.5', 'claude-opus-5.5']);
    expect(MODELS[0].label).toBe('Claude Haiku 5.5 - Recommended');
    expect(DEFAULT_MODEL).toBe('claude-haiku-5.5');
    for (const m of MODELS) expect(isVisionModel(m.slug)).toBe(true);
  });

  it('no longer offers the old gateway models', () => {
    for (const slug of ['gpt-5.6-luna', 'gpt-6-sol', 'deepseek-v4-flash', 'gemini-3.6-flash']) expect(isOfferedModel(slug)).toBe(false);
  });

  it('isVisionModel accepts any claude- slug in dot or dash form', () => {
    for (const slug of [
      'claude-haiku-5.5',
      'claude-haiku-5-5',
      'claude-sonnet-5.5',
      'claude-sonnet-5-5',
      'claude-opus-5.5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude/sonnet-5',
    ]) {
      expect(isVisionModel(slug)).toBe(true);
    }
    for (const slug of ['gpt-6-sol', 'deepseek-v4-flash', 'random-model', undefined, '']) {
      expect(isVisionModel(slug)).toBe(false);
    }
  });
});
