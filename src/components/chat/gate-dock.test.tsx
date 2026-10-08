import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import type { GatePayload, GateVariant } from '@/types';
import {
  GateDock,
  SheetOverlay,
  closeOnEscape,
  defaultVariantId,
  selectableChosen,
  sharedOpenQuestions,
  specGateDecision,
  svgDataUrl,
} from './gate-dock';

const sheet = '<svg xmlns="http://www.w3.org/2000/svg"><text>30° × 2</text></svg>';

const spec = {
  assemblyName: 'Bracket',
  openQuestions: [{ id: 'spec-q', question: 'FROM SPEC', suggestedAnswer: '10 mm' }],
} as AssemblySpec;

function button(html: string, label: string): string {
  for (const match of html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)) {
    if (match[0].includes(`${label}</button>`)) return match[0];
  }
  return '';
}

function buttonDisabled(html: string, label: string): boolean {
  const open = button(html, label).match(/^<button\b[^>]*>/)?.[0] ?? '';
  return /\sdisabled(?:=|\s|>)/.test(open);
}

function variant(over: Partial<GateVariant> & Pick<GateVariant, 'id' | 'name'>): GateVariant {
  return { idea: '', spec, sheetSvg: null, review: null, ...over };
}

const gate: GatePayload = {
  kind: 'spec',
  recommendedId: 'C',
  openQuestions: [{ id: 'shared', question: 'FROM PAYLOAD', suggestedAnswer: '40 mm', options: ['40 mm', '60 mm'] }],
  contract: null,
  revisionCount: 1,
  variants: [
    variant({
      id: 'A',
      name: 'Wide',
      idea: 'a wide stance',
      sheetSvg: sheet,
      review: {
        validated: true,
        attempts: 2,
        findings: [
          { issue: 'label tight', severity: 'minor' },
          { issue: 'lip clashes', severity: 'major' },
        ],
      },
    }),
    variant({ id: 'B', name: 'Tall', idea: 'a tall post', spec: null, error: 'could not spec' }),
    variant({
      id: 'C',
      name: 'Compact',
      idea: 'a short foot',
      review: { validated: false, attempts: 3, findings: [], note: 'budget spent' },
    }),
  ],
};

describe('svgDataUrl', () => {
  it('round-trips non-ASCII sheet text through base64', () => {
    const url = svgDataUrl(sheet);
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    expect(decoded).toBe(sheet);
  });
});

describe('variant selection', () => {
  it('defaults to the recommended variant that has a spec', () => {
    expect(defaultVariantId(gate)).toBe('C');
  });

  it('skips a recommended variant that has no spec', () => {
    const payload: GatePayload = {
      kind: 'spec',
      recommendedId: 'B',
      contract: null,
      revisionCount: 0,
      variants: [
        variant({ id: 'A', name: 'Wide' }),
        variant({ id: 'B', name: 'Tall', spec: null }),
      ],
    };
    expect(defaultVariantId(payload)).toBe('A');
  });

  it('synthesises one selectable variant for a legacy spec payload', () => {
    const payload: GatePayload = { kind: 'spec', spec, contract: null, revisionCount: 0 };
    expect(defaultVariantId(payload)).toBe('A');
    expect(sharedOpenQuestions(payload).map((q) => q.question)).toEqual(['FROM SPEC']);
  });

  it('keeps an explicit choice and ignores a choice on a variant with no spec', () => {
    expect(selectableChosen(gate, 'A')).toBe('A');
    expect(selectableChosen(gate, 'B')).toBe('C');
    expect(selectableChosen(gate, null)).toBe('C');
  });

  it('reads shared questions from the payload when the field is present', () => {
    expect(sharedOpenQuestions(gate).map((q) => q.question)).toEqual(['FROM PAYLOAD']);
  });
});

describe('specGateDecision', () => {
  it('approves the selected variant and does not send a spec', () => {
    const decision = specGateDecision(gate, 'approve', '', undefined, null);
    expect(decision).toEqual({ action: 'approve', comment: undefined, answers: undefined, chosenVariantId: 'C' });
    expect(Object.prototype.hasOwnProperty.call(decision, 'spec')).toBe(false);
  });

  it('revises with the chosen variant, the comment and the answers', () => {
    const decision = specGateDecision(gate, 'revise', 'make it shorter', { shared: '40 mm' }, 'A');
    expect(decision).toEqual({
      action: 'revise',
      comment: 'make it shorter',
      answers: { shared: '40 mm' },
      chosenVariantId: 'A',
    });
  });

  it('omits chosenVariantId on an accept gate', () => {
    const accept: GatePayload = { kind: 'accept', modelInfo: null, violations: [], code: '', revisionCount: 0 };
    const decision = specGateDecision(accept, 'approve', 'ok', undefined, 'A');
    expect(decision.chosenVariantId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(decision, 'spec')).toBe(false);
  });
});

describe('closeOnEscape', () => {
  it('closes on Escape and ignores every other key', () => {
    let closed = 0;
    closeOnEscape({ key: 'Escape' }, () => { closed += 1; });
    closeOnEscape({ key: 'Enter' }, () => { closed += 1; });
    expect(closed).toBe(1);
  });
});

describe('GateDock', () => {
  it('renders variant cards, the shared questions, and a base64 thumbnail', () => {
    const html = renderToStaticMarkup(<GateDock gate={gate} onResume={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('A - Wide');
    expect(html).toContain('a wide stance');
    expect(html).toContain('border-emerald-500/60');
    expect(html).toContain('Validated');
    expect(html).toContain('lip clashes');
    expect(html).not.toContain('label tight');
    expect(html).toContain('no sheet');
    expect(html).toContain('could not spec');
    expect(html).toContain('Not validated after 3 attempts');
    expect(html).toContain('budget spent');
    expect(html).toContain('FROM PAYLOAD');
    expect(html).not.toContain('FROM SPEC');
    expect(html).not.toContain('<text>');

    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((match) => match[0]);
    expect(radios).toHaveLength(3);
    expect(radios[0]).not.toContain('checked');
    expect(radios[1]).toContain('disabled');
    expect(radios[2]).toContain('checked');

    const src = html.match(/src="(data:image\/svg\+xml;base64,[^"]+)"/);
    expect(src).toBeTruthy();
    const decoded = Buffer.from(src![1].slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    expect(decoded).toBe(sheet);
  });

  it('renders one card for a legacy payload and its spec questions', () => {
    const legacy: GatePayload = { kind: 'spec', spec, contract: null, revisionCount: 2 };
    const html = renderToStaticMarkup(<GateDock gate={legacy} onResume={() => {}} />);
    expect(html).toContain('A - Bracket');
    expect(html).toContain('FROM SPEC');
    expect(html).toContain('no sheet');
  });

  it('shows an expired gate as closed to Approve and Revise, and still offers Deny', () => {
    const html = renderToStaticMarkup(<GateDock gate={gate} expired onResume={() => {}} />);
    expect(html).toContain('This paused run expired - send the request again');
    expect(buttonDisabled(html, 'Approve')).toBe(true);
    expect(buttonDisabled(html, 'Revise')).toBe(true);
    expect(buttonDisabled(html, 'Deny')).toBe(false);

    const fresh = renderToStaticMarkup(<GateDock gate={gate} onResume={() => {}} />);
    expect(fresh).not.toContain('This paused run expired - send the request again');
    expect(buttonDisabled(fresh, 'Approve')).toBe(false);
    expect(buttonDisabled(fresh, 'Revise')).toBe(false);
  });

  it('does not render variant cards for the accept gate', () => {
    const accept: GatePayload = { kind: 'accept', modelInfo: null, violations: [], code: 'cube(1);', revisionCount: 0 };
    const html = renderToStaticMarkup(<GateDock gate={accept} onResume={() => {}} />);
    expect(html).toContain('Review Compiled Model');
    expect(html).not.toContain('radiogroup');
  });
});

describe('SheetOverlay', () => {
  it('shows the sheet as an image with a close button', () => {
    const html = renderToStaticMarkup(<SheetOverlay svg={sheet} label="A - Wide" onClose={() => {}} />);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).not.toContain('<text>');
  });
});
