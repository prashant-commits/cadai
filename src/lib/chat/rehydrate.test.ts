import { describe, it, expect } from 'vitest';
import {
  GATE_TTL_MS,
  EXPIRED_GATE_MESSAGE,
  resumableGate,
  freezeStreamingMessages,
  stripUnchosenSheets,
  readOpenedAt,
  withOpenedAt,
  ensureGateOpenedAt,
  closedExpiredGateUpdate,
} from './rehydrate';
import { gateVariants } from '@/lib/agent/spec-variants';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import type { ChatMessage, GatePayload, GateVariant } from '@/types';

const gatePayload = { kind: 'spec', spec: null, contract: null, revisionCount: 0 } as const;

function msg(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'm1', role: 'assistant', content: '', timestamp: Date.now(), ...over };
}

describe('resumableGate', () => {
  it('finds the message holding an open gate and its run id', () => {
    const found = resumableGate([
      msg({ id: 'a', status: 'complete' }),
      msg({
        id: 'b',
        status: 'awaiting_input',
        runId: 'run-7',
        gates: { g1: { payload: gatePayload, status: 'open' } },
      }),
    ]);
    expect(found).toEqual({ messageId: 'b', runId: 'run-7', gate: gatePayload, expired: false });
  });

  it('treats an open gate older than 24 h as expired and still returns it', () => {
    const now = 1_700_000_000_000;
    const old = resumableGate([
      msg({
        id: 'b',
        timestamp: now - GATE_TTL_MS - 1,
        status: 'awaiting_input',
        runId: 'run-old',
        gates: { g1: { payload: gatePayload, status: 'open' } },
      }),
    ], now);
    expect(old).toMatchObject({ messageId: 'b', runId: 'run-old', expired: true });

    const boundary = resumableGate([
      msg({
        id: 'b',
        timestamp: now - GATE_TTL_MS,
        status: 'awaiting_input',
        runId: 'run-edge',
        gates: { g1: { payload: gatePayload, status: 'open' } },
      }),
    ], now);
    expect(boundary?.expired).toBe(false);
  });

  it('uses the gate openedAt when present and otherwise the message timestamp', () => {
    const now = 1_700_000_000_000;
    const freshRecordOnOldMessage = resumableGate([
      msg({
        timestamp: now - GATE_TTL_MS - 1,
        status: 'awaiting_input',
        runId: 'run-fresh',
        gates: { g1: withOpenedAt({ payload: gatePayload, status: 'open' }, now - 1000) },
      }),
    ], now);
    expect(freshRecordOnOldMessage?.expired).toBe(false);

    const oldRecordOnFreshMessage = resumableGate([
      msg({
        timestamp: now,
        status: 'awaiting_input',
        runId: 'run-old',
        gates: { g1: withOpenedAt({ payload: gatePayload, status: 'open' }, now - GATE_TTL_MS - 1) },
      }),
    ], now);
    expect(oldRecordOnFreshMessage?.expired).toBe(true);
  });

  it('stamps a missing openedAt from the message timestamp and leaves an existing one', () => {
    const message = msg({
      timestamp: 50,
      gates: { g1: { payload: gatePayload, status: 'open' } },
    });
    const stamped = ensureGateOpenedAt(message);
    expect(readOpenedAt(stamped.gates!.g1)).toBe(50);
    expect(ensureGateOpenedAt(stamped)).toBe(stamped);

    const kept = ensureGateOpenedAt(msg({
      timestamp: 50,
      gates: { g1: withOpenedAt({ payload: gatePayload, status: 'open' }, 10) },
    }));
    expect(readOpenedAt(kept.gates!.g1)).toBe(10);
  });

  it('closes an expired gate locally and fills a blank message with the expiry note', () => {
    const now = 80;
    const blank = msg({
      content: '',
      gates: { g1: { payload: gatePayload, status: 'open' } },
    });
    const closed = closedExpiredGateUpdate(blank, now);
    expect(closed.status).toBe('complete');
    expect(closed.content).toBe(EXPIRED_GATE_MESSAGE);
    expect(closed.gates?.g1.status).toBe('denied');
    expect(closed.gates?.g1.decision).toEqual({ action: 'cancel' });
    expect(closed.gates?.g1.decidedAt).toBe(now);

    const kept = closedExpiredGateUpdate(msg({
      content: 'Already written.',
      gates: { g1: { payload: gatePayload, status: 'open' } },
    }), now);
    expect(kept.content).toBe('Already written.');
  });

  it('ignores a gate that was already decided', () => {
    expect(
      resumableGate([
        msg({ id: 'b', status: 'complete', runId: 'run-7', gates: { g1: { payload: gatePayload, status: 'approved' } } }),
      ])
    ).toBeNull();
  });

  it('ignores an open gate with no run id, which cannot be resumed', () => {
    expect(
      resumableGate([msg({ id: 'b', status: 'awaiting_input', gates: { g1: { payload: gatePayload, status: 'open' } } })])
    ).toBeNull();
  });

  it('returns the LAST open gate when a thread somehow holds two', () => {
    const found = resumableGate([
      msg({ id: 'a', status: 'awaiting_input', runId: 'run-1', gates: { g1: { payload: gatePayload, status: 'open' } } }),
      msg({ id: 'b', status: 'awaiting_input', runId: 'run-2', gates: { g2: { payload: gatePayload, status: 'open' } } }),
    ]);
    expect(found!.runId).toBe('run-2');
  });

  it('returns null for an empty thread', () => {
    expect(resumableGate([])).toBeNull();
  });
});

describe('freezeStreamingMessages', () => {
  it('marks a message left mid-stream as interrupted', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'streaming', transcript: 'partial' })]);
    expect(out.status).toBe('interrupted');
  });

  it('gives an interrupted message body text so the bubble is never blank', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'streaming', content: '' })]);
    expect(out.content.trim()).not.toBe('');
  });

  it('leaves a message awaiting input alone - its gate is still resumable', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'awaiting_input' })]);
    expect(out.status).toBe('awaiting_input');
  });

  it('leaves completed messages untouched', () => {
    const input = [msg({ status: 'complete', content: 'done' })];
    expect(freezeStreamingMessages(input)).toEqual(input);
  });
});

const legacySpec = {
  assemblyName: 'legacy_box',
  openQuestions: [{ id: 'q', question: 'Height?', suggestedAnswer: '40 mm' }],
} as AssemblySpec;

const sheets: GateVariant[] = [
  { id: 'A', name: 'Wide', idea: '', spec: null, sheetSvg: '<svg>A</svg>', review: null },
  { id: 'B', name: 'Tall', idea: '', spec: null, sheetSvg: '<svg>B</svg>', review: null },
  { id: 'C', name: 'Compact', idea: '', spec: null, sheetSvg: '<svg>C</svg>', review: null },
];

const variantPayload: GatePayload = {
  kind: 'spec',
  variants: sheets,
  recommendedId: 'B',
  openQuestions: [{ id: 'shared', question: 'Width?', suggestedAnswer: '80 mm' }],
  contract: null,
  revisionCount: 1,
};

describe('legacy and variant spec payloads', () => {
  it('rehydrates a legacy spec payload that has no variants field', () => {
    const payload: GatePayload = { kind: 'spec', spec: legacySpec, contract: null, revisionCount: 0 };
    const found = resumableGate([
      msg({ id: 'b', status: 'awaiting_input', runId: 'run-legacy', gates: { g1: { payload, status: 'open' } } }),
    ]);
    expect(found?.gate).toBe(payload);
    const gate = found!.gate;
    if (gate.kind !== 'spec') throw new Error('expected a spec gate');
    const variants = gateVariants(gate);
    expect(variants).toHaveLength(1);
    expect(variants[0].id).toBe('A');
    expect(variants[0].name).toBe('legacy_box');
    expect(variants[0].spec?.openQuestions?.[0].question).toBe('Height?');
  });

  it('rehydrates a variant spec payload and keeps every sheet while the gate is open', () => {
    const found = resumableGate([
      msg({ id: 'b', status: 'awaiting_input', runId: 'run-new', gates: { g1: { payload: variantPayload, status: 'open' } } }),
    ]);
    expect(found?.gate).toBe(variantPayload);
    const gate = found!.gate;
    if (gate.kind !== 'spec') throw new Error('expected a spec gate');
    expect(gateVariants(gate).map((variant) => variant.sheetSvg)).toEqual(['<svg>A</svg>', '<svg>B</svg>', '<svg>C</svg>']);
    const frozen = freezeStreamingMessages([
      msg({ status: 'awaiting_input', gates: { g1: { payload: variantPayload, status: 'open' } } }),
    ]);
    expect(frozen[0].gates?.g1.payload).toBe(variantPayload);
  });
});

describe('stripUnchosenSheets', () => {
  it('leaves a legacy payload, which has no variants array, untouched', () => {
    const payload: GatePayload = { kind: 'spec', spec: legacySpec, contract: null, revisionCount: 0 };
    expect(stripUnchosenSheets(payload, { action: 'approve', chosenVariantId: 'A' })).toBe(payload);
  });

  it('nulls every sheet except the chosen variant', () => {
    const stripped = stripUnchosenSheets(variantPayload, { action: 'approve', chosenVariantId: 'C' });
    if (stripped.kind !== 'spec') throw new Error('expected a spec payload');
    expect(stripped.variants?.map((variant) => variant.sheetSvg)).toEqual([null, null, '<svg>C</svg>']);
  });

  it('keeps the recommended sheet when the decision names no variant', () => {
    const stripped = stripUnchosenSheets(variantPayload, { action: 'cancel' });
    if (stripped.kind !== 'spec') throw new Error('expected a spec payload');
    expect(stripped.variants?.map((variant) => variant.sheetSvg)).toEqual([null, '<svg>B</svg>', null]);
  });
});
