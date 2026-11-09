import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateCostUsd } from './cost-params';
import type { DesignerFacts, ReviewInput } from './types';

const ORIGINAL_REVIEWER_MODEL = process.env.CADAI_REVIEWER_MODEL;

const harness = vi.hoisted(() => {
  const calls: Array<{
    slug: string | undefined;
    schema: unknown;
    opts: unknown;
    tags?: string[];
    messages: unknown;
    config: unknown;
  }> = [];
  let reply: unknown = { flags: [] };
  let failure: unknown = null;
  const getChatModel = vi.fn((slug?: string) => ({
    withStructuredOutput(schema: unknown, opts: unknown) {
      const invoke = async (messages: unknown, config?: unknown) => {
        calls.push({ slug, schema, opts, messages, config });
        if (failure) throw failure;
        return reply;
      };
      return {
        invoke,
        withConfig(extra: { tags?: string[] }) {
          return {
            invoke: (messages: unknown, config?: unknown) => {
              calls.push({ slug, schema, opts, tags: extra.tags, messages, config });
              if (failure) throw failure;
              return reply;
            },
          };
        },
      };
    },
  }));
  return {
    calls,
    getChatModel,
    setReply(value: unknown) {
      reply = value;
      failure = null;
    },
    setFailure(value: unknown) {
      failure = value;
    },
  };
});

vi.mock('../model-provider', async () => {
  const actual = await vi.importActual<typeof import('../model-provider')>('../model-provider');
  return { ...actual, getChatModel: harness.getChatModel };
});

import { formatFlags, makeReviewer } from './reviewer';

const POISON = 'DESIGNER_TRANSCRIPT_SHOULD_NOT_LEAK';
const BUILD_POISON = 'BUILD_ID_SHOULD_NOT_BE_IN_THE_PROMPT';

function facts(overrides: Partial<DesignerFacts> = {}): DesignerFacts {
  return {
    ok: true,
    parts: [{ label: 'drawer', size: [140.2, 90, 40], valid: true }],
    interferences: [{ a: 'drawer', b: 'shell', volume: 2.5 }],
    disconnected: [],
    dimensions: [{ name: 'outer_width', value: 150 }],
    span: [150, 120, 80],
    ...overrides,
  };
}

function input(overrides: Partial<ReviewInput> = {}): ReviewInput & { messages?: unknown } {
  return {
    request: 'A drawer unit with side rails and a pull handle.',
    images: [
      { view: 'iso', dataUrl: 'data:image/png;base64,ISO' },
      { view: 'front', dataUrl: 'data:image/png;base64,FRONT' },
    ],
    facts: facts(),
    final: false,
    buildId: BUILD_POISON,
    messages: [{ role: 'assistant', content: POISON }],
    ...overrides,
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
    .join('\n');
}

function lastCall() {
  const call = harness.calls.at(-1);
  if (!call) throw new Error('model was not called');
  return call;
}

describe('makeReviewer', () => {
  beforeEach(() => {
    delete process.env.CADAI_REVIEWER_MODEL;
    harness.calls.length = 0;
    harness.getChatModel.mockClear();
    harness.setReply({ flags: [] });
  });

  afterEach(() => {
    if (ORIGINAL_REVIEWER_MODEL === undefined) delete process.env.CADAI_REVIEWER_MODEL;
    else process.env.CADAI_REVIEWER_MODEL = ORIGINAL_REVIEWER_MODEL;
  });

  it('sends the request, facts and images, and never the designer transcript', async () => {
    const review = makeReviewer();
    expect(harness.getChatModel).not.toHaveBeenCalled();

    await review(input());
    await review(input({ final: true, request: 'second request' }));

    expect(harness.getChatModel).toHaveBeenCalledTimes(2);
    expect(harness.getChatModel).toHaveBeenNthCalledWith(1, 'claude-sonnet-5.5');
    expect(harness.getChatModel).toHaveBeenNthCalledWith(2, 'claude-sonnet-5.5');

    const call = lastCall();
    expect(call.opts).toEqual({ name: 'DesignReview', method: 'jsonSchema', includeRaw: true });
    expect(call.tags).toEqual(['nostream']);
    expect(JSON.stringify(call.opts)).not.toContain('temperature');
    expect(JSON.stringify(call.schema)).toContain('blocking');

    const messages = call.messages as [SystemMessage, HumanMessage];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(HumanMessage);

    const system = textOf(messages[0].content);
    expect(system).toContain(
      'You are an independent senior product-design reviewer. Judge whether this design works for the request in real use: it does the job, it is stable when it should stand, it is reachable, moving parts work, it can be made, and the form is coherent.'
    );
    expect(system).toContain('Return at most 3 concrete flags, most severe first.');
    expect(system).toContain('Never flag differences in style or interpretation, or a mismatch with any plan.');
    expect(system).toContain('There is no floor or z = 0 rule.');
    expect(system).toContain('A blocking flag means the design fails the request in use.');

    const firstSystem = textOf((harness.calls[0].messages as [SystemMessage])[0].content);
    expect(firstSystem).not.toContain('A blocking flag means the design fails the request in use.');

    const human = messages[1].content as Array<{ type?: string; text?: string; image_url?: { url: string } }>;
    expect(textOf(human)).toContain('second request');
    expect(textOf(human)).toContain('outer_width');
    expect(textOf(human)).toContain('drawer');
    expect(textOf(human)).toContain('View: iso');
    expect(textOf(human)).toContain('View: front');
    const images = human.filter((part) => part.type === 'image_url');
    expect(images.map((part) => part.image_url?.url)).toEqual([
      'data:image/png;base64,ISO',
      'data:image/png;base64,FRONT',
    ]);

    const payload = JSON.stringify(call.messages);
    expect(payload).not.toContain(POISON);
    expect(payload).not.toContain(BUILD_POISON);
    expect(payload).not.toContain('assistant');
  });

  it('uses opts.model, then CADAI_REVIEWER_MODEL, then Sonnet 5.5', async () => {
    process.env.CADAI_REVIEWER_MODEL = 'claude-haiku-5.5';
    await makeReviewer({ model: 'claude-opus-5.5' })(input());
    expect(harness.getChatModel).toHaveBeenLastCalledWith('claude-opus-5.5');

    await makeReviewer()(input());
    expect(harness.getChatModel).toHaveBeenLastCalledWith('claude-haiku-5.5');

    delete process.env.CADAI_REVIEWER_MODEL;
    await makeReviewer()(input());
    expect(harness.getChatModel).toHaveBeenLastCalledWith('claude-sonnet-5.5');

    process.env.CADAI_REVIEWER_MODEL = 'not-a-model';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await makeReviewer()(input());
    expect(harness.getChatModel).toHaveBeenLastCalledWith('claude-sonnet-5.5');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('parses flags, drops malformed ones, and keeps the three most severe', async () => {
    const long = `x${'y'.repeat(500)}`;
    harness.setReply({
      flags: [
        { severity: 'minor', issue: 'label is a bit plain', whyItMatters: 'only cosmetic' },
        { severity: 'BLOCKING', issue: `tips\u0000 forward ${long}`, why_it_matters: 'it falls over in use' },
        { severity: 'major', issue: 'the handle is out of reach', why: 'a seated user cannot pull it' },
        { severity: 'blocking', issue: 'the drawer jams on the rail', whyItMatters: 'it does not slide' },
        { severity: 'catastrophic', issue: 'not a severity', whyItMatters: 'dropped' },
        { severity: 'minor', issue: '   ', whyItMatters: 'blank issue' },
        'not an object',
        { severity: 'major' },
      ],
    });

    const clipped = `tips forward ${long}`.replace('\u0000', '').slice(0, 400);
    const out = await makeReviewer()(input());
    expect(out.flags).toEqual([
      { severity: 'blocking', issue: clipped, whyItMatters: 'it falls over in use' },
      { severity: 'blocking', issue: 'the drawer jams on the rail', whyItMatters: 'it does not slide' },
      { severity: 'major', issue: 'the handle is out of reach', whyItMatters: 'a seated user cannot pull it' },
    ]);
    expect(out.flags[0].issue).toHaveLength(400);
    expect(out.flags[0].issue).not.toContain('\u0000');
  });

  it('returns no flags for malformed output and keeps the usage cost', async () => {
    const raw = new AIMessage({
      content: 'not json',
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
      },
    });
    harness.setReply({ parsed: null, raw });
    const review = makeReviewer();
    const out = await review(input());
    expect(out.flags).toEqual([]);
    expect(out.costUsd).toBe(estimateCostUsd('claude-sonnet-5.5', { input_tokens: 10, output_tokens: 4 }));
    expect(review.lastError).toBeInstanceOf(Error);
    expect((review.lastError as Error).message).toMatch(/malformed/);
  });

  it('returns no flags when the model call throws, and records lastError', async () => {
    harness.setFailure(new Error('provider 500'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const review = makeReviewer();
    const out = await review(input());
    expect(out).toEqual({ flags: [], costUsd: 0 });
    expect(review.lastError).toBeInstanceOf(Error);
    expect((review.lastError as Error).message).toBe('provider 500');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('passes the abort signal through and does not swallow an abort', async () => {
    const controller = new AbortController();
    await makeReviewer()(input({ signal: controller.signal }));
    expect(lastCall().config).toEqual({ signal: controller.signal });

    controller.abort();
    harness.calls.length = 0;
    const review = makeReviewer();
    await expect(review(input({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.calls).toHaveLength(0);
    expect(review.lastError).toMatchObject({ name: 'AbortError' });
  });

  it('computes cost from usage, including cache tokens, for the selected model', async () => {
    const raw = new AIMessage({
      content: '{"flags":[]}',
      usage_metadata: {
        input_tokens: 1000,
        output_tokens: 200,
        total_tokens: 2400,
        input_token_details: { cache_creation: 400, cache_read: 800 },
      },
    });
    harness.setReply({
      parsed: { flags: [] },
      raw,
    });
    const out = await makeReviewer({ model: 'claude-opus-5.5' })(input());
    const usage = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 400,
      cache_read_input_tokens: 800,
    };
    expect(out.costUsd).toBe(estimateCostUsd('claude-opus-5.5', usage));
    expect(out.costUsd).not.toBe(estimateCostUsd('claude-opus-5.5', { input_tokens: 1000, output_tokens: 200 }));
    expect(out.costUsd).not.toBe(estimateCostUsd('claude-sonnet-5.5', usage));
    expect(out.flags).toEqual([]);
  });
});

describe('formatFlags', () => {
  it('escapes markdown and HTML-like text, one line per flag', () => {
    const lines = formatFlags(
      [
        {
          severity: 'blocking',
          issue: 'use *bold* and <script>',
          whyItMatters: 'a & b [click](http://evil)',
        },
        { severity: 'minor', issue: 'sharp\ncorner', whyItMatters: 'it snags' },
      ],
      false
    );
    expect(lines).toBe(
      [
        '**Reviewer (blocking):** use \\*bold\\* and &lt;script&gt; — a &amp; b \\[click\\]\\(http://evil\\)',
        '**Reviewer (minor):** sharp corner — it snags',
      ].join('\n')
    );
    expect(formatFlags([], true)).toBe('');
    expect(formatFlags([{ severity: 'major', issue: 'jams', whyItMatters: 'it will not open' }], true)).toBe(
      '**Final reviewer (major):** jams — it will not open'
    );
  });

  it('an attachment reaches the designer and the reviewer as an image block', async () => {
    const rev = makeReviewer();
    const refDataUrl = 'data:image/png;base64,REF1';
    const isoDataUrl = 'data:image/png;base64,ISO';
    await rev(
      input({
        images: [
          { view: 'iso', dataUrl: isoDataUrl },
          { view: 'reference:1', dataUrl: refDataUrl },
        ],
      })
    );
    const call = lastCall();
    const humanMsg = (call.messages as unknown[])[1] as HumanMessage;
    const content = humanMsg.content as Array<{ type: string; [k: string]: unknown }>;

    const refIndex = content.findIndex(
      (b) => b.type === 'text' && b.text === "User's reference image 1"
    );
    expect(refIndex).toBeGreaterThan(-1);
    expect(content[refIndex + 1]).toEqual({
      type: 'image_url',
      image_url: { url: refDataUrl },
    });

    const isoIndex = content.findIndex(
      (b) => b.type === 'text' && b.text === 'View: iso'
    );
    expect(isoIndex).toBeGreaterThan(-1);
    expect(content[isoIndex + 1]).toEqual({
      type: 'image_url',
      image_url: { url: isoDataUrl },
    });

    expect(refIndex).toBeLessThan(isoIndex);

    const sysMsg = (call.messages as unknown[])[0] as SystemMessage;
    expect(textOf(sysMsg.content)).toContain(
      'Reference images, when present, show what the user wants, and are not renders.'
    );
  });

  it('the reviewer labels a markup image markup:1 with the markup sentence', async () => {
    const rev = makeReviewer();
    const markupDataUrl = 'data:image/png;base64,markupbytes';
    await rev(
      input({
        images: [
          { view: 'markup:1', dataUrl: markupDataUrl },
        ],
      })
    );
    const call = lastCall();
    const humanMsg = (call.messages as unknown[])[1] as HumanMessage;
    const content = humanMsg.content as Array<{ type: string; [k: string]: unknown }>;

    const markupIndex = content.findIndex(
      (b) =>
        b.type === 'text' &&
        typeof b.text === 'string' &&
        b.text === "User's markup image 1"
    );
    expect(markupIndex).toBeGreaterThan(-1);
    expect(content[markupIndex + 1]).toEqual({
      type: 'image_url',
      image_url: { url: markupDataUrl },
    });
    // The sentence says "the image above", so it follows the image.
    expect(content[markupIndex + 2]).toEqual({
      type: 'text',
      text: 'The image above is a screenshot of the current design that the user drew on. The marks show the change they want; everything under the marks is the current design, not a target.',
    });
    expect(JSON.stringify(content)).not.toContain('reference image');
  });
});
