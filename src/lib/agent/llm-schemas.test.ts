import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ChatAnthropic } from '@langchain/anthropic';
import {
  structuredFor,
  unusableStop,
  isCutOff,
  UnusableReplyError,
  StopCheckedJsonOutputParser,
  isPlainObject,
} from './llm-schemas';

describe('llm-schemas', () => {
  describe('isPlainObject', () => {
    it('identifies plain objects and rejects arrays, null, primitives', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject('string')).toBe(false);
      expect(isPlainObject(123)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
    });
  });

  describe('unusableStop and isCutOff', () => {
    it('returns null for normal replies or missing metadata', () => {
      expect(unusableStop(null)).toBe(null);
      expect(unusableStop({})).toBe(null);
      expect(unusableStop({ response_metadata: { stop_reason: 'stop' } })).toBe(null);
      expect(unusableStop({ response_metadata: { stop_reason: 'end_turn' } })).toBe(null);
      expect(unusableStop({ additional_kwargs: { stop_reason: 'stop' } })).toBe(null);
    });

    it('detects refusal from response_metadata or additional_kwargs', () => {
      expect(unusableStop({ response_metadata: { stop_reason: 'refusal' } })).toBe('refusal');
      expect(unusableStop({ additional_kwargs: { stop_reason: 'refusal' } })).toBe('refusal');
      expect(isCutOff('refusal')).toBe(false);
    });

    it('detects cut-off stop reasons and marks them in isCutOff', () => {
      const cutOffs = ['max_tokens', 'model_context_window_exceeded', 'pause_turn'] as const;
      for (const stop of cutOffs) {
        expect(unusableStop({ response_metadata: { stop_reason: stop } })).toBe(stop);
        expect(unusableStop({ additional_kwargs: { stop_reason: stop } })).toBe(stop);
        expect(isCutOff(stop)).toBe(true);
      }
      expect(isCutOff(null)).toBe(false);
      expect(isCutOff(undefined)).toBe(false);
    });
  });

  describe('UnusableReplyError', () => {
    it('sets name and message correctly', () => {
      const err = new UnusableReplyError('max_tokens');
      expect(err.name).toBe('UnusableReplyError');
      expect(err.stop).toBe('max_tokens');
      expect(err.message).toContain('max_tokens');
    });
  });

  describe('StopCheckedJsonOutputParser', () => {
    it('throws UnusableReplyError on a truncated or refused reply', async () => {
      const parser = new StopCheckedJsonOutputParser();
      const message = { response_metadata: { stop_reason: 'max_tokens' } };
      await expect(
        parser.parseResult([{ text: '{"partial": true}', message: message as never }])
      ).rejects.toThrow(UnusableReplyError);
    });

    it('parses valid JSON when the reply was not cut off', async () => {
      const parser = new StopCheckedJsonOutputParser();
      const message = { response_metadata: { stop_reason: 'end_turn' } };
      const res = await parser.parseResult([{ text: '{"hello": "world"}', message: message as never }]);
      expect(res).toEqual({ hello: 'world' });
    });
  });

  describe('structuredFor', () => {
    const FORBIDDEN = [
      'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
      'multipleOf', 'minLength', 'maxLength', 'pattern', 'default',
    ];

    const recorder = () => {
      const seen: Array<{ schema: unknown; opts: unknown }> = [];
      return {
        seen,
        model: {
          withStructuredOutput(schema: unknown, opts: unknown) {
            seen.push({ schema, opts });
            return 'bound';
          },
        },
      };
    };

    const SampleSchema = z.object({
      fieldA: z.string(),
      severity: z.enum(['minor', 'major']),
    });

    it('non-Claude slugs pass schema and opts through untouched', () => {
      const luna = recorder();
      structuredFor(luna.model as never, 'gpt-5.6-luna', SampleSchema, { name: 'Sample', strict: true });
      expect(luna.seen[0].schema).toBe(SampleSchema);
      expect(luna.seen[0].opts).toEqual({ name: 'Sample', strict: true });

      const sol = recorder();
      const rawJson = { type: 'object', properties: { x: { type: 'number' } } };
      structuredFor(sol.model as never, 'gpt-6-sol', rawJson, { name: 'Custom' });
      expect(sol.seen[0].schema).toBe(rawJson);
      expect(sol.seen[0].opts).toEqual({ name: 'Custom' });
    });

    it('claude slugs get an Anthropic-safe strict JSON schema with jsonSchema method', () => {
      const claude = recorder();
      structuredFor(claude.model as never, 'claude-opus-5.5', SampleSchema, { name: 'Sample', strict: true });
      const sent = JSON.stringify(claude.seen[0].schema);
      for (const k of FORBIDDEN) {
        expect(sent).not.toContain(`"${k}"`);
      }
      expect(claude.seen[0].opts).toEqual({ name: 'Sample', method: 'jsonSchema' });
      expect((claude.seen[0].schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    });

    it('passes includeRaw through for claude slugs', () => {
      const claude = recorder();
      structuredFor(claude.model as never, 'claude-haiku-5.5', SampleSchema, {
        name: 'Sample',
        includeRaw: true,
      });
      expect(claude.seen[0].opts).toEqual({ name: 'Sample', method: 'jsonSchema', includeRaw: true });
    });

    it('uses native json_schema format on ChatAnthropic instances', () => {
      const model = new ChatAnthropic({
        apiKey: 'test-key',
        model: 'claude-sonnet-5-5',
      });
      const bound = structuredFor(model, 'claude-sonnet-5.5', SampleSchema, { name: 'Sample' });
      expect(bound).toBeDefined();
    });
  });

  it('contains no stale gateway comments in schema and storage files', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const files = [
      path.resolve(__dirname, 'llm-schemas.ts'),
      path.resolve(__dirname, 'strict-schema.ts'),
      path.resolve(__dirname, '../storage/thread-storage.ts'),
    ];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toContain('The gateway enforces');
      expect(content).not.toContain('The gateway forwards');
      expect(content).not.toContain('a slug the gateway still serves');
      expect(content).not.toContain('through the gateway');
    }
  });
});
