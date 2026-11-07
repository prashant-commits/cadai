import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { AgentStateType } from '../graph';
import type { AssemblySpec } from '../assembly-spec';
import { resolveSpec } from '../spec-expr';
import { makeBrepAgentBuild } from './brep-agent-build';
import { validateBrep } from './validate-brep';
import { auditNesting } from '../nesting-audit';
import { getBuildRequirements, clearBuildRequirementsCache } from '../requirements';
import * as brepRunner from '../../engine/brep-runner';

const ASCII_STL = 'solid model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid model\n';

describe('ab2: Requirements checklist caching', () => {
  beforeEach(() => {
    delete process.env.CADAI_AGENT_MAX_TURNS;
    delete process.env.CADAI_AGENT_MAX_RENDERS;
    clearBuildRequirementsCache();
  });

  afterEach(() => {
    clearBuildRequirementsCache();
  });

  it('generates requirements checklist once and caches per prompt/build', async () => {
    clearBuildRequirementsCache();
    const fakeStructured = {
      invoke: vi.fn().mockResolvedValue({
        requirements: [
          { id: 'dim_width', text: 'width is 100 mm', kind: 'dimension' },
          { id: 'feat_lid', text: 'has hinged lid', kind: 'feature' },
        ],
      }),
    };
    const fakeModel = {
      withStructuredOutput: vi.fn().mockReturnValue(fakeStructured),
    };

    const prompt = 'hinged box with 100mm width';
    const res1 = await getBuildRequirements(prompt, 'fake-model', fakeModel);
    expect(res1.requirements).toHaveLength(2);
    expect(res1.requirements[0].id).toBe('dim_width');
    expect(fakeStructured.invoke).toHaveBeenCalledTimes(1);

    // Second call with same prompt returns cached result without invoking LLM
    const res2 = await getBuildRequirements(prompt, 'fake-model', fakeModel);
    expect(res2).toEqual(res1);
    expect(fakeStructured.invoke).toHaveBeenCalledTimes(1);

    // After clearing cache, LLM is called again
    clearBuildRequirementsCache();
    const res3 = await getBuildRequirements(prompt, 'fake-model', fakeModel);
    expect(res3).toEqual(res1);
    expect(fakeStructured.invoke).toHaveBeenCalledTimes(2);
  });
});

describe('ab2: Stacking and crate nesting audit', () => {
  it('detects nesting violation when stacking lip exceeds host opening', () => {
    const spec = {
      assemblyName: 'stackable_crate',
      parameters: [],
      components: [
        { name: 'crate_body', localExtents: [160, 120, 80], position: [0, 0, 0], shape: { kind: 'box' } },
        { name: 'floor', localExtents: [154, 114, 4], position: [3, 3, 0], shape: { kind: 'box' } },
        { name: 'stacking_lip', localExtents: [157, 117, 5], position: [1.5, 1.5, 0], shape: { kind: 'box' } },
      ],
      boundingBox: { width: 160, length: 120, height: 80 },
    } as unknown as AssemblySpec;

    // Stacking lip is 157x117 mm, host opening (floor) is 154x114 mm
    const parts = [
      { label: 'crate_body', min: [0, 0, 0], max: [160, 120, 80] },
      { label: 'stacking_lip', min: [1.5, 1.5, 0], max: [158.5, 118.5, 5] },
    ];

    const violations = auditNesting(spec, parts, 'stackable crate');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain('Nesting fit violation');
    expect(violations[0].message).toContain('stacking_lip');
    expect(violations[0].message).toContain('cannot fit or nest');
    expect(violations[0].severity).toBe('error');
  });

  it('passes nesting check when stacking lip fits host opening with clearance', () => {
    const spec = {
      assemblyName: 'stackable_crate',
      parameters: [],
      components: [
        { name: 'crate_body', localExtents: [160, 120, 80], position: [0, 0, 0], shape: { kind: 'box' } },
        { name: 'floor', localExtents: [154, 114, 4], position: [3, 3, 0], shape: { kind: 'box' } },
        { name: 'stacking_lip', localExtents: [152, 112, 5], position: [4, 4, 0], shape: { kind: 'box' } },
      ],
      boundingBox: { width: 160, length: 120, height: 80 },
    } as unknown as AssemblySpec;

    const parts = [
      { label: 'crate_body', min: [0, 0, 0], max: [160, 120, 80] },
      { label: 'stacking_lip', min: [4, 4, 0], max: [156, 116, 5] },
    ];

    const violations = auditNesting(spec, parts, 'stackable crate');
    expect(violations).toHaveLength(0);
  });
});

describe('ab2: validateBrep omitted components and connectivity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('omitted components become notes in validateBrep, missing non-omitted components are errors', async () => {
    vi.spyOn(brepRunner, 'runBrep').mockResolvedValue({
      ok: true,
      parts: [
        { label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [100, 100, 10] },
      ],
      solids: 1,
      bbox: { min: [0, 0, 0], max: [100, 100, 10] },
      stl: Buffer.from(ASCII_STL).toString('base64'),
      ms: 50,
    });

    const twoPartSpec = resolveSpec({
      assemblyName: 'box',
      boundingBox: { width: 100, length: 100, height: 50 },
      parameters: [],
      components: [
        { name: 'base', localExtents: [100, 100, 10], position: [0, 0, 0], shape: { kind: 'box' } },
        { name: 'lid', localExtents: [100, 100, 5], position: [0, 0, 10], shape: { kind: 'box' } },
      ],
    } as unknown as AssemblySpec).spec;

    // Case 1: lid is omitted in buildNotes -> treated as note, validateBrep does not fail with missing error
    const resWithOmitted = await validateBrep({
      currentCode: 'base = Box(100, 100, 10)\nbase.label = "base"\n_cadai_parts = [base]\nresult = base',
      assemblySpec: twoPartSpec,
      attemptCount: 1,
      compileFailures: 0,
      failureKind: 'none',
      buildNotes: [{ name: 'lid', reason: 'lid consolidated into base' }],
    } as never);

    const missingErrors = (resWithOmitted.specViolations ?? []).filter(
      (v) => v.field === 'lid' && v.measured === 'missing'
    );
    expect(missingErrors).toHaveLength(0);

    // Case 2: lid is NOT omitted in buildNotes -> validateBrep produces an error for missing component
    const resWithoutOmitted = await validateBrep({
      currentCode: 'base = Box(100, 100, 10)\nbase.label = "base"\n_cadai_parts = [base]\nresult = base',
      assemblySpec: twoPartSpec,
      attemptCount: 1,
      compileFailures: 0,
      failureKind: 'none',
      buildNotes: [],
    } as never);

    const missingLid = (resWithoutOmitted.specViolations ?? []).find(
      (v) => v.field === 'lid' && v.measured === 'missing'
    );
    expect(missingLid).toBeDefined();
    expect(missingLid?.severity).toBe('error');
    expect(resWithoutOmitted.isValid).toBe(false);
  });

  it('validateBrep connectivity check flags disconnected parts', async () => {
    vi.spyOn(brepRunner, 'runBrep').mockResolvedValue({
      ok: true,
      parts: [
        { label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [100, 100, 10] },
        { label: 'floating_lid', valid: true, volume: 500, min: [0, 0, 50], max: [100, 100, 60] },
      ],
      disconnected: ['floating_lid'],
      solids: 2,
      bbox: { min: [0, 0, 0], max: [100, 100, 60] },
      stl: Buffer.from(ASCII_STL).toString('base64'),
      ms: 50,
    });

    const res = await validateBrep({
      currentCode: 'code',
      assemblySpec: {
        assemblyName: 'box',
        parameters: [],
        components: [
          { name: 'base', localExtents: [100, 100, 10], position: [0, 0, 0], shape: { kind: 'box' } },
          { name: 'floating_lid', localExtents: [100, 100, 10], position: [0, 0, 50], shape: { kind: 'box' } },
        ],
      } as unknown as AssemblySpec,
      attemptCount: 1,
      compileFailures: 0,
      failureKind: 'none',
      buildNotes: [],
    } as never);

    const disconn = (res.specViolations ?? []).find((v) => v.field === 'floating_lid' && v.measured === 'disconnected');
    expect(disconn).toBeDefined();
    expect(disconn?.severity).toBe('error');
    expect(disconn?.message).toContain('disconnected part');
    expect(disconn?.message).toContain('floating_lid');
    expect(res.isValid).toBe(false);
  });
});

describe('ab2: brepAgentBuild finish rejections', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.CADAI_AGENT_MAX_TURNS;
    delete process.env.CADAI_AGENT_MAX_RENDERS;
    clearBuildRequirementsCache();
  });

  afterEach(() => {
    delete process.env.CADAI_AGENT_MAX_TURNS;
    delete process.env.CADAI_AGENT_MAX_RENDERS;
    clearBuildRequirementsCache();
  });

  const baseSpec = resolveSpec({
    sheet: '## Box\nA hinged lid box.',
    assemblyName: 'box',
    boundingBox: { width: 100, length: 100, height: 50 },
    parameters: [
      { name: 'lid_open_deg', value: 0, min: 0, max: 90, unit: 'deg', description: 'lid angle' },
    ],
    components: [
      { name: 'base', localExtents: [100, 100, 40], position: [0, 0, 0], shape: { kind: 'box' } },
      { name: 'lid', localExtents: [100, 100, 10], position: [0, 0, 40], shape: { kind: 'box' } },
    ],
    jointContracts: [
      { type: 'hinge', partA: 'base', partB: 'lid', clearance: 0.5 },
    ],
  } as unknown as AssemblySpec).spec;

  /**
   * Helper to execute brepAgentBuild with scripted model turns and capture tool error.
   */
  async function runBuildWithTurns(
    turns: AIMessage[],
    runBrepImpl?: (script: string) => Promise<unknown>,
    specOverride?: AssemblySpec
  ): Promise<string | null> {
    delete process.env.CADAI_AGENT_MAX_TURNS;
    delete process.env.CADAI_AGENT_MAX_RENDERS;

    vi.spyOn(brepRunner, 'runBrep').mockImplementation(async (script) => {
      if (runBrepImpl) return runBrepImpl(script) as never;
      return {
        ok: true,
        parts: [
          { label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [100, 100, 40] },
          { label: 'lid', valid: true, volume: 500, min: [0, 0, 40], max: [100, 100, 50] },
        ],
        solids: 2,
        bbox: { min: [0, 0, 0], max: [100, 100, 50] },
        stl: Buffer.from(ASCII_STL).toString('base64'),
        ms: 50,
        interferences: [],
      } as never;
    });

    let turnIdx = 0;
    let toolError: string | null = null;

    const fakeModel = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockImplementation(async (msgs: unknown[]) => {
        // Search conversation for the most recent tool error
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i] as ToolMessage;
          if (m && typeof m.content === 'string') {
            try {
              const parsed = JSON.parse(m.content);
              if (parsed.error) {
                toolError = parsed.error;
                break;
              }
            } catch {
              // ignore
            }
          }
        }
        if (turnIdx < turns.length) {
          return turns[turnIdx++];
        }
        return new AIMessage({ content: 'Stopping' });
      }),
    };

    const agentBuild = makeBrepAgentBuild(fakeModel as never);
    const state = {
      assemblySpec: specOverride ?? baseSpec,
      currentCode: '',
      attemptCount: 0,
      messages: [new HumanMessage('hinged lid box')],
      failureKind: 'none',
    } as unknown as AgentStateType;

    await agentBuild(state);
    return toolError;
  }

  it('rejects finish when a spec component is missing from _cadai_parts and not in omitted', async () => {
    const scriptWithoutLid = `from build123d import *
lid_open_deg = 0  # [0:5:90]
base = Box(100, 100, 40)
base.label = 'base'
_cadai_parts = [base]
result = base
`;
    const turns = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'run_script', args: { script: scriptWithoutLid } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_2',
          name: 'finish',
          args: {
            script: scriptWithoutLid,
            requirements: [{ id: 'cad_request', status: 'met' }],
          },
        }],
      }),
    ];

    const err = await runBuildWithTurns(turns, async () => ({
      ok: true,
      parts: [{ label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [100, 100, 40] }],
      solids: 1,
      bbox: { min: [0, 0, 0], max: [100, 100, 40] },
      stl: Buffer.from(ASCII_STL).toString('base64'),
      ms: 50,
      interferences: [],
    }));

    expect(err).toContain('Finish rejected');
    expect(err).toContain('missing from _cadai_parts');
    expect(err).toContain('lid');
  });

  it('rejects finish when moving part exists but script has no pose parameter', async () => {
    const scriptWithoutPose = `from build123d import *
base = Box(100, 100, 40)
lid = Pos(0, 0, 40) * Box(100, 100, 10)
base.label = 'base'
lid.label = 'lid'
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;
    const turns = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'run_script', args: { script: scriptWithoutPose } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_2',
          name: 'finish',
          args: {
            script: scriptWithoutPose,
            requirements: [{ id: 'cad_request', status: 'met' }],
          },
        }],
      }),
    ];

    const err = await runBuildWithTurns(turns);
    expect(err).toContain('Finish rejected');
    expect(err).toContain('Moving parts');
    expect(err).toContain('does not expose a pose parameter ending in _deg or _travel');
  });

  it('rejects finish when moving pose parameter was not tested at range max', async () => {
    const scriptWithPose = `from build123d import *
lid_open_deg = 0  # [0:5:90] lid angle
base = Box(100, 100, 40)
lid = Pos(0, 0, 40) * Box(100, 100, 10)
base.label = 'base'
lid.label = 'lid'
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;
    const turns = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'run_script', args: { script: scriptWithPose } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_2',
          name: 'finish',
          args: {
            script: scriptWithPose,
            requirements: [{ id: 'cad_request', status: 'met' }],
          },
        }],
      }),
    ];

    const err = await runBuildWithTurns(turns);
    expect(err).toContain('Finish rejected');
    expect(err).toContain('Pose parameter \'lid_open_deg\' was not run at its range max (90)');
  });

  it('rejects finish when pose parameter changes part volume/size', async () => {
    const scriptWithPose = `from build123d import *
lid_open_deg = 0  # [0:5:90] lid angle
base = Box(100, 100, 40)
lid = Pos(0, 0, 40) * Box(100, 100, 10)
base.label = 'base'
lid.label = 'lid'
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;
    const turns = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'run_script', args: { script: scriptWithPose } }],
      }),
      // Render at max pose 90
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_2', name: 'render', args: { overrides: { lid_open_deg: 90 } } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_3',
          name: 'finish',
          args: {
            script: scriptWithPose,
            requirements: [{ id: 'cad_request', status: 'met' }],
          },
        }],
      }),
    ];

    // Mock where lid volume changes from 500 in closed pose to 1000 in open pose
    const err = await runBuildWithTurns(turns, async (script: string) => {
      const isOpen = script.includes('lid_open_deg = 90');
      return {
        ok: true,
        parts: [
          { label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [100, 100, 40] },
          { label: 'lid', valid: true, volume: isOpen ? 1000 : 500, min: [0, 0, 40], max: [100, 100, 50] },
        ],
        solids: 2,
        bbox: { min: [0, 0, 0], max: [100, 100, 50] },
        stl: Buffer.from(ASCII_STL).toString('base64'),
        ms: 50,
        interferences: [],
      };
    });

    expect(err).toContain('Finish rejected');
    expect(err).toContain('changes the size/volume of part \'lid\'');
  });

  it('rejects finish when requirements checklist item is missing or unmet without reason', async () => {
    const scriptWithPose = `from build123d import *
lid_open_deg = 0  # [0:5:90] lid angle
base = Box(100, 100, 40)
lid = Pos(0, 0, 40) * Box(100, 100, 10)
base.label = 'base'
lid.label = 'lid'
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;

    // Case A: Missing requirement
    const turnsA = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'run_script', args: { script: scriptWithPose } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_2', name: 'render', args: { overrides: { lid_open_deg: 90 } } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_3',
          name: 'finish',
          args: {
            script: scriptWithPose,
            requirements: [], // Empty requirements!
          },
        }],
      }),
    ];

    const errA = await runBuildWithTurns(turnsA);
    expect(errA).toContain('Finish rejected');
    expect(errA).toContain('missing from finish requirements checklist');

    // Case B: Requirement marked unmet without evidence
    const turnsB = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'run_script', args: { script: scriptWithPose } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_2', name: 'render', args: { overrides: { lid_open_deg: 90 } } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_3',
          name: 'finish',
          args: {
            script: scriptWithPose,
            requirements: [{ id: 'cad_request', status: 'unmet' }], // Unmet without reason/evidence
          },
        }],
      }),
    ];

    const errB = await runBuildWithTurns(turnsB);
    expect(errB).toContain('Finish rejected');
    expect(errB).toContain('marked unmet without an explanation in evidence');
  });
});
