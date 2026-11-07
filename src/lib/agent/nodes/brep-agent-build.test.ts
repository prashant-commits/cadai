import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentStateType } from '../graph';
import type { AssemblySpec } from '../assembly-spec';
import { resolveSpec } from '../spec-expr';
import { makeBrepAgentBuild, applyParameterOverrides, checkScriptGuardrails, renderCompactSpec } from './brep-agent-build';
import * as brepRunner from '../../engine/brep-runner';
import { routeAfterSpecGate, repairTarget, draftTarget } from '../graph-route';

const spec = resolveSpec({
  sheet: '## Dock\nA desktop dock.',
  assemblyName: 'dock',
  boundingBox: { width: 180, length: 120, height: 110 },
  guides: [],
  stressPoints: [],
  assumptions: [],
  openQuestions: [],
  parameters: [
    { name: 'lean_deg', value: 70, min: 64, max: 90, unit: 'deg', description: 'backrest lean' },
    { name: 'lid_open_deg', value: 0, min: 0, max: 120, unit: 'deg', description: 'lid angle' },
  ],
  components: [
    { name: 'base', description: 'base plate', localExtents: [180, 120, 8], position: [0, 0, 0], shape: { kind: 'box' } },
    { name: 'lid', description: 'storage lid', localExtents: [160, 40, 4], position: [10, 70, 38], shape: { kind: 'box' } },
  ],
} as unknown as AssemblySpec).spec;

const ASCII_STL = 'solid model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid model\n';

const SCRIPT_1 = `from build123d import *
lean_deg = 70  # [64:1:90] backrest lean
lid_open_deg = 0  # [0:5:120] lid angle
base = Box(180, 120, 8, align=(Align.MIN, Align.MIN, Align.MIN))
lid = Pos(10, 70, 38) * Box(160, 40, 4, align=(Align.MIN, Align.MIN, Align.MIN))
base.label = 'base'
lid.label = 'lid'
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;

const SCRIPT_2 = `from build123d import *
lean_deg = 70  # [64:1:90] backrest lean
lid_open_deg = 0  # [0:5:120] lid angle
base = Box(180, 120, 8, align=(Align.MIN, Align.MIN, Align.MIN))
lid = Pos(10, 70, 38) * Box(160, 40, 4, align=(Align.MIN, Align.MIN, Align.MIN))
base.label = 'base'
lid.label = 'lid'
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;

const SCRIPT_FINAL = `from build123d import *
lean_deg = 72  # [64:1:90] backrest lean
lid_open_deg = 0  # [0:5:120] lid angle
base = Box(180, 120, 8, align=(Align.MIN, Align.MIN, Align.MIN))
lid = Pos(10, 70, 38) * Box(160, 40, 4, align=(Align.MIN, Align.MIN, Align.MIN))
base.label = 'base'
lid.label = 'lid'
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;

describe('applyParameterOverrides', () => {
  it('updates parameter lines while keeping comments and ranges', () => {
    const out = applyParameterOverrides(SCRIPT_1, { lid_open_deg: 100 });
    expect(out).toContain('lid_open_deg = 100  # [0:5:120] lid angle');
    expect(out).toContain('lean_deg = 70  # [64:1:90] backrest lean');
  });
});

describe('checkScriptGuardrails', () => {
  it('accepts compliant scripts', () => {
    expect(checkScriptGuardrails(SCRIPT_1).ok).toBe(true);
  });

  it('rejects forbidden imports', () => {
    expect(checkScriptGuardrails(SCRIPT_1 + '\nimport os').ok).toBe(false);
  });

  it('rejects builder-mode context managers', () => {
    expect(checkScriptGuardrails(SCRIPT_1 + '\nwith BuildPart(): pass').ok).toBe(false);
  });
});

describe('renderCompactSpec', () => {
  it('formats designLanguage with principles and radii', () => {
    const s = resolveSpec({
      assemblyName: 'dock',
      designLanguage: {
        name: 'soft monolith',
        principles: ['one continuous body', 'soft 6mm radius'],
        edgeRadius: 6,
        minorRadius: 1.5,
      },
      boundingBox: { width: 100, length: 100, height: 50 },
    } as unknown as AssemblySpec).spec;
    const out = renderCompactSpec(s);
    expect(out).toContain('Assembly: dock');
    expect(out).toContain('Design Language: soft monolith (edgeRadius: 6 mm, minorRadius: 1.5 mm)');
    expect(out).toContain('  - one continuous body');
    expect(out).toContain('  - soft 6mm radius');
  });
});

describe('brepAgentBuild tool loop end to end', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.CADAI_AGENT_MAX_TURNS;
    delete process.env.CADAI_AGENT_MAX_RENDERS;
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  it('executes run -> render with override -> run -> finish sequence', async () => {
    const runBrepSpy = vi.spyOn(brepRunner, 'runBrep').mockImplementation(async (script) => {
      const isOverridden = script.includes('lid_open_deg = 100');
      return {
        ok: true,
        parts: [
          { label: 'base', valid: true, volume: 180 * 120 * 8, min: [0, 0, 0], max: [180, 120, 8] },
          { label: 'lid', valid: true, volume: 160 * 40 * 4, min: [10, 70, 38], max: [170, 110, 42] },
        ],
        solids: 2,
        bbox: { min: [0, 0, 0], max: [180, 120, 42] },
        stl: Buffer.from(ASCII_STL).toString('base64'),
        ms: 100,
        interferences: isOverridden ? [] : [{ a: 'base', b: 'lid', volume: 2.5 }],
      };
    });

    const scriptedReplies = [
      // Turn 1: run_script
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_1',
          name: 'run_script',
          args: { script: SCRIPT_1 },
        }],
      }),
      // Turn 2: render with override
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_2',
          name: 'render',
          args: { overrides: { lid_open_deg: 100 } },
        }],
      }),
      // Turn 3: run_script with revision
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_3',
          name: 'run_script',
          args: { script: SCRIPT_2 },
        }],
      }),
      // Turn 4: finish
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_4',
          name: 'finish',
          args: {
            script: SCRIPT_FINAL,
            notes: ['the box sits 17 mm in so it does not cover the rear mounting holes'],
          },
        }],
      }),
    ];

    let turnIndex = 0;
    const fakeModel = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockImplementation(async () => {
        return scriptedReplies[turnIndex++];
      }),
    };

    const deltas: string[] = [];
    const writer = vi.fn((event: { t: string; text?: string }) => {
      if (event.t === 'delta' && event.text) deltas.push(event.text);
    });

    const agentBuild = makeBrepAgentBuild(fakeModel as never);
    const state = {
      assemblySpec: spec,
      currentCode: '',
      attemptCount: 0,
      messages: [new HumanMessage('dock with hinged lid')],
      failureKind: 'none',
    } as unknown as AgentStateType;

    const out = await agentBuild(state, { writer } as never);

    expect(out.currentCode).toBe(SCRIPT_FINAL);
    expect(out.attemptCount).toBe(1);
    expect(out.failureKind).toBe('none');
    expect(out.buildNotes).toEqual([{
      name: '',
      reason: 'the box sits 17 mm in so it does not cover the rear mounting holes',
    }]);

    // Verify render overrides changed the parameter line in the call to runBrep
    const renderCall = runBrepSpy.mock.calls.find((call) => call[0].includes('lid_open_deg = 100'));
    expect(renderCall).toBeDefined();

    // Verify stream deltas emitted clean progress without raw model text or tool JSON
    expect(deltas.length).toBeGreaterThanOrEqual(4);
    expect(deltas.some((d) => d.includes('run ok'))).toBe(true);
    expect(deltas.some((d) => d.includes('render lid_open_deg=100'))).toBe(true);
    expect(deltas.some((d) => d.includes('finished'))).toBe(true);
    for (const d of deltas) {
      expect(d).not.toContain('tool_calls');
      expect(d).not.toContain('SCRIPT_');
    }
  });

  it('respects turn budget CADAI_AGENT_MAX_TURNS', async () => {
    process.env.CADAI_AGENT_MAX_TURNS = '2';

    vi.spyOn(brepRunner, 'runBrep').mockResolvedValue({
      ok: true,
      parts: [],
      solids: 1,
      ms: 10,
    });

    const fakeModel = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue(
        new AIMessage({
          content: '',
          tool_calls: [{
            id: 'call_loop',
            name: 'run_script',
            args: { script: SCRIPT_1 },
          }],
        })
      ),
    };

    const agentBuild = makeBrepAgentBuild(fakeModel as never);
    const state = {
      assemblySpec: spec,
      currentCode: '',
      attemptCount: 0,
      messages: [new HumanMessage('prompt')],
      failureKind: 'none',
    } as unknown as AgentStateType;

    const out = await agentBuild(state);
    // Terminated after 2 turns
    expect(fakeModel.invoke).toHaveBeenCalledTimes(2);
    // Uses the last script that ran ok
    expect(out.currentCode).toBe(SCRIPT_1);
  });

  it('respects render budget CADAI_AGENT_MAX_RENDERS', async () => {
    process.env.CADAI_AGENT_MAX_RENDERS = '1';

    vi.spyOn(brepRunner, 'runBrep').mockResolvedValue({
      ok: true,
      parts: [],
      solids: 1,
      stl: Buffer.from(ASCII_STL).toString('base64'),
      ms: 10,
    });

    const capturedToolResults: unknown[] = [];
    let turn = 0;
    const fakeModel = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockImplementation(async (messages: BaseMessage[]) => {
        turn++;
        if (turn === 1) {
          return new AIMessage({
            content: '',
            tool_calls: [{ id: 'c1', name: 'render', args: {} }],
          });
        }
        if (turn === 2) {
          const toolMsg = messages.find((m) => m._getType() === 'tool');
          capturedToolResults.push(toolMsg?.content);
          return new AIMessage({
            content: '',
            tool_calls: [{ id: 'c2', name: 'render', args: {} }],
          });
        }
        const toolMsg = messages.filter((m) => m._getType() === 'tool').pop();
        capturedToolResults.push(toolMsg?.content);
        return new AIMessage({
          content: '',
          tool_calls: [{ id: 'c3', name: 'finish', args: { script: SCRIPT_1 } }],
        });
      }),
    };

    const agentBuild = makeBrepAgentBuild(fakeModel as never);
    const state = {
      assemblySpec: spec,
      currentCode: '',
      attemptCount: 0,
      messages: [new HumanMessage('prompt')],
      failureKind: 'none',
    } as unknown as AgentStateType;

    await agentBuild(state);

    // The second render was rejected with budget exhausted
    const secondResult = JSON.stringify(capturedToolResults[1]);
    expect(secondResult).toContain('Render budget exhausted');
  });

  it('routes to brepAgentBuild when CADAI_BUILD_MODE=agent', () => {
    process.env.CADAI_BUILD_MODE = 'agent';
    const state = {
      pipeline: 'architect',
      kernel: 'brep',
      assemblySpec: spec,
      attemptCount: 1,
      maxAttempts: 3,
      isValid: false,
      failureKind: 'compile',
      semanticFailures: 0,
    } as unknown as AgentStateType;

    expect(repairTarget(state)).toBe('brepAgentBuild');
    expect(draftTarget(state)).toBe('brepAgentBuild');
    expect(routeAfterSpecGate(state)).toBe('brepAgentBuild');
  });

  it('routes to brepBuild when CADAI_BUILD_MODE is default (oneshot)', () => {
    delete process.env.CADAI_BUILD_MODE;
    const state = {
      pipeline: 'architect',
      kernel: 'brep',
      assemblySpec: spec,
      attemptCount: 1,
      maxAttempts: 3,
      isValid: false,
      failureKind: 'compile',
      semanticFailures: 0,
    } as unknown as AgentStateType;

    expect(repairTarget(state)).toBe('brepBuild');
    expect(draftTarget(state)).toBe('brepBuild');
    expect(routeAfterSpecGate(state)).toBe('brepBuild');
  });
});
