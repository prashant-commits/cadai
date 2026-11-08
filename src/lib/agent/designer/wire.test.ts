import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import * as modelProvider from '../model-provider';
import { getChatModel } from '../model-provider';
import { DEFAULT_MODEL } from '../models';
import { cachedSystemMessage } from '../system-prompt';
import { DESIGNER_SYSTEM_PROMPT } from './prompt';
import { designerTools } from './tools';
import { makeReviewer, ReviewerReplySchema } from './reviewer';
import { runDesigner } from './run-designer';
import { UnusableReplyError } from '../llm-schemas';
import { withFakeClient, reply, type Body } from '../__fixtures__/fake-anthropic';

const saved = { ...process.env };
const realGetChatModel = modelProvider.getChatModel;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  for (const k of ['CADAI_MODEL', 'CADAI_MAX_TOKENS', 'CADAI_MODEL_TIMEOUT_MS', 'CADAI_THINKING', 'CADAI_EFFORT', 'CADAI_BUILD_THINKING', 'CADAI_BUILD_EFFORT']) {
    delete process.env[k];
  }
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('wire tests (fake Anthropic client)', () => {
  describe('cachedSystemMessage', () => {
    it('returns a SystemMessage with an ephemeral cache_control block', () => {
      const prompt = 'Test system instructions';
      const msg = cachedSystemMessage(prompt);
      expect(msg.content).toEqual([{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }]);
    });
  });

  describe('designer call on the wire', () => {
    it('builds the model with bindTools(auto), native schema and sets wire parameters for DEFAULT_MODEL', async () => {
      const model = getChatModel(DEFAULT_MODEL, { role: 'build' });
      const tools = designerTools();
      const bound = model.bindTools(tools, { tool_choice: 'auto' });
      const bodies = withFakeClient(model, () => reply([{ type: 'text', text: 'planning geometry' }]));

      const res = await bound.invoke([
        cachedSystemMessage(DESIGNER_SYSTEM_PROMPT),
        new HumanMessage('design a phone stand'),
      ]);

      expect(res.content).toBe('planning geometry');
      expect(bodies).toHaveLength(1);
      const body = bodies[0];

      // System prompt is cached block
      expect(body.system).toEqual([
        { type: 'text', text: DESIGNER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ]);

      // Tools sent natively with input_schema and tool_choice: auto
      expect(body.tools).toBeDefined();
      expect(body.tools.map((t: { name: string }) => t.name)).toEqual(tools.map((t) => t.name));
      for (const tool of body.tools) {
        expect(tool.input_schema).toBeDefined();
      }
      expect(body.tool_choice).toEqual({ type: 'auto' });

      // No temperature
      expect(body.temperature).toBeUndefined();

      // Model metadata and build-role parameters for Sonnet 5.5
      expect(body.model).toBe('claude-sonnet-5-5');
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'low' });
      expect(body.max_tokens).toBe(64000);
    });

    it('sets wire parameters correctly for Haiku 5.5 (thinking disabled, effort high, maxTokens 32000)', async () => {
      const model = getChatModel('claude-haiku-5.5', { role: 'build' });
      const tools = designerTools();
      const bound = model.bindTools(tools, { tool_choice: 'auto' });
      const bodies = withFakeClient(model, () => reply([{ type: 'text', text: 'drafting code' }]));

      await bound.invoke([
        cachedSystemMessage(DESIGNER_SYSTEM_PROMPT),
        new HumanMessage('design a simple wedge'),
      ]);

      expect(bodies).toHaveLength(1);
      const body = bodies[0];
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.output_config).toEqual({ effort: 'high' });
      expect(body.max_tokens).toBe(32000);
      expect(body.temperature).toBeUndefined();
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body.system).toEqual([
        { type: 'text', text: DESIGNER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('proves the real runDesigner code path invokes the wire client with the exact parameters', async () => {
      let recordedBody: Body | undefined;
      const abortCtrl = new AbortController();

      vi.spyOn(modelProvider, 'getChatModel').mockImplementation((slug, opts) => {
        const real = realGetChatModel(slug, opts);
        withFakeClient(real, (body) => {
          recordedBody = body;
          // Abort after first turn body is recorded so runDesigner ends cleanly without loops
          abortCtrl.abort();
          return reply([{ type: 'text', text: 'Starting design' }]);
        });
        return real;
      });

      await runDesigner(
        { request: 'a minimalist pencil holder', buildId: 'wire-test-1' },
        { signal: abortCtrl.signal },
      );

      expect(recordedBody).toBeDefined();
      expect(recordedBody?.system).toEqual([
        { type: 'text', text: DESIGNER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ]);
      expect(recordedBody?.tool_choice).toEqual({ type: 'auto' });
      expect(recordedBody?.tools.map((t: { name: string }) => t.name)).toEqual(designerTools().map((t) => t.name));
      expect(recordedBody?.model).toBe('claude-sonnet-5-5');
      expect(recordedBody?.temperature).toBeUndefined();
    });
  });

  describe('reviewer call on the wire', () => {
    it('constrains the reviewer output with output_config json_schema, cached system prompt, and returns parsed flags', async () => {
      let recordedBody: Body | undefined;

      const fakeFlags = [
        { severity: 'major' as const, issue: 'Wall too thin', whyItMatters: 'Fails under mechanical stress' },
        { severity: 'minor' as const, issue: 'Missing outer fillet', whyItMatters: 'Tactile feel would improve' },
      ];

      vi.spyOn(modelProvider, 'getChatModel').mockImplementation((slug, opts) => {
        const real = realGetChatModel(slug, opts);
        withFakeClient(real, (body) => {
          recordedBody = body;
          return reply([{ type: 'text', text: JSON.stringify({ flags: fakeFlags }) }]);
        });
        return real;
      });

      const reviewer = makeReviewer();
      const result = await reviewer({
        request: 'make a wall-mounted bracket',
        images: [],
        facts: { ok: true, parts: [], interferences: [], disconnected: [], dimensions: [] },
        final: false,
      });

      expect(result.flags).toEqual(fakeFlags);
      expect(reviewer.lastError).toBeNull();

      expect(recordedBody).toBeDefined();
      // Cached system message
      expect(recordedBody?.system).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('You are an independent senior product-design reviewer'),
          cache_control: { type: 'ephemeral' },
        },
      ]);
      // JSON schema output format
      expect(recordedBody?.output_config?.format?.type).toBe('json_schema');
      const schemaProperties = recordedBody?.output_config?.format?.schema?.properties;
      expect(schemaProperties).toBeDefined();
      expect(Object.keys(schemaProperties).sort()).toEqual(
        Object.keys(ReviewerReplySchema.shape).sort()
      );
      // No tools, no tool_choice, no temperature
      expect(recordedBody?.tools).toBeUndefined();
      expect(recordedBody?.tool_choice).toBeUndefined();
      expect(recordedBody?.temperature).toBeUndefined();
    });

    it('sets lastError to UnusableReplyError on refusal stop_reason and returns no flags', async () => {
      vi.spyOn(modelProvider, 'getChatModel').mockImplementation((slug, opts) => {
        const real = realGetChatModel(slug, opts);
        withFakeClient(real, () => reply([], 'refusal'));
        return real;
      });

      const reviewer = makeReviewer();
      const result = await reviewer({
        request: 'make a bracket',
        images: [],
        facts: { ok: true, parts: [], interferences: [], disconnected: [], dimensions: [] },
        final: false,
      });

      expect(result.flags).toEqual([]);
      expect(reviewer.lastError).toBeInstanceOf(UnusableReplyError);
      expect((reviewer.lastError as UnusableReplyError).stop).toBe('refusal');
    });

    it('sets lastError to UnusableReplyError on max_tokens stop_reason and returns no flags', async () => {
      vi.spyOn(modelProvider, 'getChatModel').mockImplementation((slug, opts) => {
        const real = realGetChatModel(slug, opts);
        withFakeClient(real, () => reply([], 'max_tokens'));
        return real;
      });

      const reviewer = makeReviewer();
      const result = await reviewer({
        request: 'make a bracket',
        images: [],
        facts: { ok: true, parts: [], interferences: [], disconnected: [], dimensions: [] },
        final: false,
      });

      expect(result.flags).toEqual([]);
      expect(reviewer.lastError).toBeInstanceOf(UnusableReplyError);
      expect((reviewer.lastError as UnusableReplyError).stop).toBe('max_tokens');
    });
  });
});
