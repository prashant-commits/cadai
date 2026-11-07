import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { AgentStateType } from '../graph';
import type { AssemblySpec } from '../assembly-spec';
import { resolveSpec } from '../spec-expr';
import { makeBrepAgentBuild, checkScriptGuardrails, applyParameterOverrides, BREP_AGENT_SYSTEM_PROMPT } from './brep-agent-build';
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

    // Case 2: lid is NOT omitted in buildNotes -> validateBrep produces an error for missing component in agent mode
    const resWithoutOmitted = await validateBrep({
      buildMode: 'agent',
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

    // Case 3: In oneshot mode, missing component is a warning, not a hard error
    const resOneshot = await validateBrep({
      buildMode: 'oneshot',
      currentCode: 'base = Box(100, 100, 10)\nbase.label = "base"\n_cadai_parts = [base]\nresult = base',
      assemblySpec: twoPartSpec,
      attemptCount: 1,
      compileFailures: 0,
      failureKind: 'none',
      buildNotes: [],
    } as never);
    const oneshotMissing = (resOneshot.specViolations ?? []).find(
      (v) => v.field === 'lid' && v.measured === 'missing'
    );
    expect(oneshotMissing?.severity).toBe('warning');
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
      buildMode: 'agent',
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

    // In oneshot mode, disconnected is a warning
    const resOneshot = await validateBrep({
      buildMode: 'oneshot',
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
    const oneshotDisconn = (resOneshot.specViolations ?? []).find((v) => v.field === 'floating_lid' && v.measured === 'disconnected');
    expect(oneshotDisconn?.severity).toBe('warning');
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

  it('system prompt instructs pose parameters default to closed/home pose (range min)', () => {
    expect(BREP_AGENT_SYSTEM_PROMPT).toContain(
      'Pose parameters default to the closed/home pose (their range min); the model the user sees first is closed.'
    );
  });

  it('rejects finish when a pose parameter (_deg) defaults to open/non-min value', async () => {
    const scriptHalfOpen = `from build123d import *
lid_open_deg = 50  # [0:5:90] lid angle
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
        tool_calls: [{ id: 'call_1', name: 'run_script', args: { script: scriptHalfOpen } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_2',
          name: 'finish',
          args: {
            script: scriptHalfOpen,
            requirements: [{ id: 'cad_request', status: 'met' }],
          },
        }],
      }),
    ];

    const err = await runBuildWithTurns(turns);
    expect(err).toContain('Finish rejected');
    expect(err).toContain("Pose parameter 'lid_open_deg' defaults to 50");
    expect(err).toContain('must default to its closed/home pose');
    expect(err).toContain('range min 0');
  });

  it('rejects finish when a drawer pose parameter (_travel) defaults to non-min value', async () => {
    const scriptDrawerOpen = `from build123d import *
pull_out_travel = 50  # [0:10:100] drawer pull out travel in mm
cabinet = Box(120, 120, 60)
drawer = Pos(0, 0, 0) * Box(100, 100, 40)
cabinet.label = 'cabinet'
drawer.label = 'drawer'
_cadai_parts = [cabinet, drawer]
result = Compound([cabinet, drawer])
`;
    const turns = [
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'run_script', args: { script: scriptDrawerOpen } }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_2',
          name: 'finish',
          args: {
            script: scriptDrawerOpen,
            requirements: [{ id: 'cad_request', status: 'met' }],
          },
        }],
      }),
    ];

    const drawerSpec = resolveSpec({
      assemblyName: 'drawer_cabinet',
      boundingBox: { width: 120, length: 120, height: 60 },
      parameters: [{ name: 'pull_out_travel', value: 50, min: 0, max: 100, unit: 'mm', description: 'drawer travel' }],
      components: [
        { name: 'cabinet', description: 'cabinet frame', localExtents: [120, 120, 60], position: [0, 0, 0], shape: { kind: 'box' } },
        { name: 'drawer', description: 'sliding drawer', localExtents: [100, 100, 40], position: [0, 0, 0], shape: { kind: 'box' } },
      ],
      jointContracts: [
        { type: 'slide', partA: 'cabinet', partB: 'drawer', clearance: 0.5 },
      ],
    } as unknown as AssemblySpec).spec;

    const runBrepDrawer = async () => ({
      ok: true,
      parts: [
        { label: 'cabinet', valid: true, volume: 1000, min: [0, 0, 0], max: [120, 120, 60] },
        { label: 'drawer', valid: true, volume: 500, min: [0, 0, 0], max: [100, 100, 40] },
      ],
      solids: 2,
      bbox: { min: [0, 0, 0], max: [120, 120, 60] },
      stl: Buffer.from(ASCII_STL).toString('base64'),
      ms: 50,
      interferences: [],
    });

    const err = await runBuildWithTurns(turns, runBrepDrawer, drawerSpec);
    expect(err).toContain('Finish rejected');
    expect(err).toContain("Pose parameter 'pull_out_travel' defaults to 50");
    expect(err).toContain('must default to its closed/home pose');
  });

  it('rejects finish when connectivity returns not checked (> 40 parts) (L3)', async () => {
    const staticSpec = resolveSpec({
      assemblyName: 'box',
      boundingBox: { width: 10, length: 10, height: 10 },
      components: [{ name: 'base', description: 'base box', localExtents: [10, 10, 10], position: [0, 0, 0], shape: { kind: 'box' } }],
    } as unknown as AssemblySpec).spec;

    const turns = [
      new AIMessage({
        content: 'I finish now',
        tool_calls: [{
          id: 'finish_1',
          name: 'finish',
          args: {
            script: 'from build123d import *\nbase = Box(10, 10, 10)\nbase.label = "base"\n_cadai_parts = [base]\nresult = base',
            requirements: [{ id: 'cad_request', status: 'met' }],
          },
        }],
      }),
    ];

    const err = await runBuildWithTurns(
      turns,
      async () => ({
        ok: true,
        solids: 41,
        parts: [
          { label: 'base', valid: true, volume: 10, min: [0, 0, 0], max: [1, 1, 1] },
          ...Array.from({ length: 40 }, (_, i) => ({ label: `p${i}`, valid: true, volume: 10, min: [0, 0, 0], max: [1, 1, 1] })),
        ],
        disconnected: 'not checked',
        ms: 10,
      }),
      staticSpec
    );

    expect(err).toContain('Finish rejected: Connectivity not checked: model has more than 40 parts');
  });
});

const ESCAPE = `from build123d import *
def g():
    yield h.gi_frame.f_back.f_back.f_builtins
h = g()
b = next(h)
o = b['op' + 'en']
result = Box(1, 1, 1)
`;

describe('ab2 review regression tests (P1-P10)', () => {
  const probeSpec = resolveSpec({
    assemblyName: 'box',
    boundingBox: { width: 100, length: 100, height: 50 },
    parameters: [{ name: 'lid_open_deg', value: 0, min: 0, max: 90, unit: 'deg', description: 'lid angle' }],
    components: [
      { name: 'base', localExtents: [100, 100, 40], position: [0, 0, 0], shape: { kind: 'box' } },
      { name: 'lid', localExtents: [100, 100, 10], position: [0, 0, 40], shape: { kind: 'box' } },
    ],
    jointContracts: [{ type: 'hinge', partA: 'base', partB: 'lid', clearance: 0.5 }],
  } as never).spec;

  const probeSTL = Buffer.from('solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n').toString('base64');

  function okParts(vols: [number, number]) {
    return {
      ok: true,
      parts: [
        { label: 'base', valid: true, volume: vols[0], min: [0, 0, 0], max: [100, 100, 40] },
        { label: 'lid', valid: true, volume: vols[1], min: [0, 0, 40], max: [100, 100, 50] },
      ],
      solids: 2,
      bbox: { min: [0, 0, 0], max: [100, 100, 50] },
      stl: probeSTL,
      ms: 5,
      interferences: [],
      disconnected: [],
    };
  }

  async function driveProbe(turns: AIMessage[], impl: (s: string) => unknown) {
    const scripts: string[] = [];
    vi.spyOn(brepRunner, 'runBrep').mockImplementation(async (s: string) => {
      scripts.push(s);
      return impl(s) as never;
    });
    const tool: string[] = [];
    let i = 0;
    const model = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn(async (msgs: unknown[]) => {
        const last = msgs[msgs.length - 1];
        if (last instanceof ToolMessage && typeof last.content === 'string') tool.push(last.content);
        return i < turns.length ? turns[i++] : new AIMessage({ content: 'stop' });
      }),
    };
    const writes: unknown[] = [];
    const out = await makeBrepAgentBuild(model as never)(
      {
        assemblySpec: probeSpec,
        currentCode: '',
        attemptCount: 0,
        messages: [new HumanMessage('hinged lid box')],
        failureKind: 'none',
      } as never,
      { writer: (e: unknown) => writes.push(e) } as never
    );
    return { out, scripts, tool, writes };
  }

  const callTool = (name: string, args: object, id = Math.random().toString()) =>
    new AIMessage({ content: '', tool_calls: [{ id, name, args }] });

  beforeEach(() => {
    vi.restoreAllMocks();
    clearBuildRequirementsCache();
    delete process.env.CADAI_AGENT_MAX_TURNS;
  });

  it('P1: guardrail rejects frame escape and prelude-prefix bypasses', () => {
    expect(checkScriptGuardrails(ESCAPE).ok).toBe(false);
    expect(checkScriptGuardrails('from build123d import *; import os\nresult = Box(1,1,1)').ok).toBe(false);
    expect(checkScriptGuardrails('fused = (1).__class__.__mro__\nresult = Box(1,1,1)').ok).toBe(false);
    expect(checkScriptGuardrails('t = type(Box)\nresult = Box(1,1,1)').ok).toBe(false);
    expect(checkScriptGuardrails("x = f'{1}'\nresult = Box(1,1,1)").ok).toBe(false);
  });

  it('P2: override injection is rejected for invalid keys and non-numeric values', () => {
    const s = 'lid_open_deg = 0  # [0:5:90] a\nresult = Box(1,1,1)';
    const o = applyParameterOverrides(s, { lid_open_deg: '0\nimport os', 'x\nimport sys\ny': 1 });
    expect(o).not.toContain('import os');
    expect(o).not.toContain('import sys');
  });

  it('P3: guardrail-rejected script is never rendered and never becomes currentCode', async () => {
    const bad = 'from build123d import *\nimport os\nresult = Box(1,1,1)';
    const r = await driveProbe(
      [callTool('run_script', { script: bad }), callTool('render', { overrides: { lid_open_deg: 10 } })],
      () => okParts([1000, 500])
    );
    expect(r.scripts.some((s) => s.includes('import os'))).toBe(false);
    expect(r.out.currentCode).not.toContain('import os');
  });

  it('P4: render override injection does not leak into runner or deltas', async () => {
    const good = 'from build123d import *\nlid_open_deg = 0  # [0:5:90] a\nresult = Box(1,1,1)';
    const r = await driveProbe(
      [callTool('run_script', { script: good }), callTool('render', { overrides: { lid_open_deg: '0; import os' } })],
      () => okParts([1000, 500])
    );
    expect(r.scripts.some((s) => s.includes('import os'))).toBe(false);
    const deltas = r.writes.map((w) => (w as { text?: string }).text).join('');
    expect(deltas).not.toContain('import os');
  });

  it('P5: refined script v2 finishes without stale baseline volume rejection', async () => {
    const v1 = 'from build123d import *\nlid_open_deg = 0  # [0:5:90] a\nresult = Box(1,1,1)';
    const v2 = v1 + '\n# refined';
    const r = await driveProbe(
      [
        callTool('run_script', { script: v1 }),
        callTool('run_script', { script: v2 }),
        callTool('render', { overrides: { lid_open_deg: 90 } }),
        callTool('finish', { script: v2, requirements: [{ id: 'cad_request', status: 'met' }] }),
      ],
      (s) => {
        if (s.includes('lid_open_deg = 90')) {
          return {
            ok: true,
            parts: [
              { label: 'base', valid: true, volume: 800, min: [0, 0, 0], max: [100, 100, 40] },
              { label: 'lid', valid: true, volume: 400, min: [0, 0, 40], max: [100, 100, 140] },
            ],
            solids: 2,
            bbox: { min: [0, 0, 0], max: [100, 100, 140] },
            stl: probeSTL,
            ms: 5,
            interferences: [],
            disconnected: [],
          };
        }
        if (s.includes('refined')) return okParts([800, 400]);
        return okParts([1000, 500]);
      }
    );
    expect(r.tool.at(-1)).not.toContain('changes the size');
    expect(r.writes.map((w) => (w as { text?: string }).text).join('')).toContain('finished');
  });

  it('P6: pose parameter that moves nothing is rejected; tests on older script do not count', async () => {
    const v1 = 'from build123d import *\nlid_open_deg = 0  # [0:5:90] unused\nresult = Box(1,1,1)';
    // Case A: pose does not move geometry
    const rA = await driveProbe(
      [
        callTool('run_script', { script: v1 }),
        callTool('render', { overrides: { lid_open_deg: 90 } }),
        callTool('finish', { script: v1, requirements: [{ id: 'cad_request', status: 'met' }] }),
      ],
      () => okParts([1000, 500])
    );
    expect(rA.tool.at(-1)).toContain('does not move any part in the geometry');

    // Case B: testing v1 at max does not let v2 finish without testing v2 at max
    const v2 = 'from build123d import *\nlid_open_deg = 0  # [0:5:90] unused\nresult = Box(2,2,2) # totally different';
    const rB = await driveProbe(
      [
        callTool('run_script', { script: v1 }),
        callTool('render', { overrides: { lid_open_deg: 90 } }),
        callTool('finish', { script: v2, requirements: [{ id: 'cad_request', status: 'met' }] }),
      ],
      () => okParts([1000, 500])
    );
    expect(rB.tool.at(-1)).toContain("Pose parameter 'lid_open_deg' was not run at its range max (90) on this script version");
  });

  it('P7: omitted with empty reason or omitting all components is rejected', async () => {
    const s = 'from build123d import *\nlid_open_deg = 0  # [0:5:90] a\nresult = Box(1,1,1)';
    const rA = await driveProbe(
      [
        callTool('run_script', { script: s }),
        callTool('finish', {
          script: s,
          omitted: [{ component: 'base', reason: '' }, { component: 'lid', reason: '' }],
          requirements: [{ id: 'cad_request', status: 'met' }],
        }),
      ],
      () => ({ ...okParts([1, 1]), parts: [{ label: 'x', valid: true, volume: 1, min: [0, 0, 0], max: [1, 1, 1] }] })
    );
    expect(rA.tool.at(-1)).toContain('empty or insufficient reason');

    const rB = await driveProbe(
      [
        callTool('run_script', { script: s }),
        callTool('finish', {
          script: s,
          omitted: [{ component: 'base', reason: 'consolidated' }, { component: 'lid', reason: 'consolidated' }],
          requirements: [{ id: 'cad_request', status: 'met' }],
        }),
      ],
      () => ({ ...okParts([1, 1]), parts: [{ label: 'x', valid: true, volume: 1, min: [0, 0, 0], max: [1, 1, 1] }] })
    );
    expect(rB.tool.at(-1)).toContain('Cannot omit all spec components');
  });

  it('P8: finish then run_script in same reply ignores trailing calls and retains validated script', async () => {
    const s = 'from build123d import *\nlid_open_deg = 0  # [0:5:90] a\nresult = Box(1,1,1)';
    const other = 'from build123d import *\nresult = Box(9,9,9)';
    const r = await driveProbe(
      [
        callTool('run_script', { script: s }),
        callTool('render', { overrides: { lid_open_deg: 90 } }),
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'f', name: 'finish', args: { script: s, requirements: [{ id: 'cad_request', status: 'met' }] } },
            { id: 'r', name: 'run_script', args: { script: other } },
          ],
        }),
      ],
      (script) => {
        if (script.includes('lid_open_deg = 90')) {
          return {
            ok: true,
            parts: [
              { label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [100, 100, 40] },
              { label: 'lid', valid: true, volume: 500, min: [0, 0, 40], max: [100, 100, 140] },
            ],
            solids: 2,
            bbox: { min: [0, 0, 0], max: [100, 100, 140] },
            stl: probeSTL,
            ms: 5,
            interferences: [],
            disconnected: [],
          };
        }
        return okParts([1000, 500]);
      }
    );
    expect(r.out.currentCode).toBe(s);
    expect(r.out.currentCode).not.toBe(other);
    expect(r.scripts.some((sc) => sc.includes('Box(9,9,9)'))).toBe(false);
  });

  it('P9: tool calls are capped at 5 per turn', async () => {
    process.env.CADAI_AGENT_MAX_TURNS = '1';
    const s = 'from build123d import *\nresult = Box(1,1,1)';
    const calls = Array.from({ length: 25 }, (_, k) => ({ id: `c${k}`, name: 'run_script', args: { script: s } }));
    const r = await driveProbe([new AIMessage({ content: '', tool_calls: calls })], () => okParts([1, 1]));
    expect(r.scripts.length).toBe(5);
  });

  it('P10: nesting audit does not produce false positives for hinges and handles reversed drawer order', () => {
    const sp = {
      assemblyName: 'box',
      components: [],
      jointContracts: [{ type: 'hinge', partA: 'base', partB: 'lid', clearance: 0.3 }],
    } as never;
    const v = auditNesting(sp, [{ label: 'base', min: [0, 0, 0], max: [100, 60, 40] }, { label: 'lid', min: [0.1, 0, 40], max: [99.9, 60, 45] }], 'hinged box');
    expect(v.length).toBe(0);

    const sp2 = {
      assemblyName: 'cab',
      components: [],
      jointContracts: [{ type: 'drawer_slide', partA: 'drawer', partB: 'shell', clearance: 0.5 }],
    } as never;
    const v2 = auditNesting(sp2, [{ label: 'drawer', min: [2, 0, 2], max: [98, 80, 40] }, { label: 'shell', min: [0, 0, 0], max: [100, 80, 45] }], 'drawer');
    expect(v2.length).toBe(0);
  });
});

describe('ab2m Item 3: Per-build run budget (wall time and USD)', () => {
  beforeEach(() => {
    delete process.env.CADAI_AGENT_MAX_WALL_S;
    delete process.env.CADAI_AGENT_MAX_USD;
    delete process.env.CADAI_AGENT_MAX_TURNS;
  });

  afterEach(() => {
    delete process.env.CADAI_AGENT_MAX_WALL_S;
    delete process.env.CADAI_AGENT_MAX_USD;
    delete process.env.CADAI_AGENT_MAX_TURNS;
  });

  it('CADAI_AGENT_MAX_WALL_S applies across all brepAgentBuild visits in a run', async () => {
    process.env.CADAI_AGENT_MAX_WALL_S = '10'; // 10 seconds limit for build
    const fakeModel = {
      invoke: vi.fn().mockImplementation(async () => {
        return new AIMessage({
          content: 'Working',
          tool_calls: [{
            id: 'call_run',
            name: 'run_script',
            args: { script: 'from build123d import *\nresult = Box(10, 10, 10)' },
          }],
        });
      }),
    };

    vi.spyOn(brepRunner, 'runBrep').mockResolvedValue({
      ok: true,
      parts: [{ label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
      solids: 1,
      ms: 10,
    });

    const agentBuild = makeBrepAgentBuild(fakeModel as never);

    // Visit 1: starts with 0 ms, runs for a bit
    const stateVisit1 = {
      assemblySpec: resolveSpec({
        assemblyName: 'box',
        boundingBox: { width: 10, length: 10, height: 10 },
        components: [{ name: 'base', description: 'base box', localExtents: [10, 10, 10], position: [0, 0, 0], shape: { kind: 'box' } }],
      } as unknown as AssemblySpec).spec,
      currentCode: '',
      attemptCount: 0,
      buildWallMs: 0,
      buildCostUsd: 0,
      buildNotes: [],
      messages: [new HumanMessage('simple box')],
      failureKind: 'none',
    } as unknown as AgentStateType;

    const out1 = await agentBuild(stateVisit1);
    expect(out1.buildWallMs).toBeGreaterThan(0);

    // Visit 2: starts with 11 seconds already elapsed (exceeding 10s budget)
    const stateVisit2 = {
      ...stateVisit1,
      currentCode: out1.currentCode,
      attemptCount: out1.attemptCount ?? 1,
      buildWallMs: 11_000, // 11s elapsed in prior visits
      buildCostUsd: out1.buildCostUsd ?? 0,
      buildNotes: out1.buildNotes ?? [],
    } as unknown as AgentStateType;

    const out2 = await agentBuild(stateVisit2);
    // Should end immediately with last guardrail-passed script and a note
    expect(out2.currentCode).toBe(out1.currentCode);
    const budgetNote = out2.buildNotes?.find((n) => n.reason.includes('wall time limit of 10s exceeded'));
    expect(budgetNote).toBeDefined();
  });

  it('CADAI_AGENT_MAX_USD applies across all brepAgentBuild visits in a run', async () => {
    process.env.CADAI_AGENT_MAX_USD = '0.50'; // $0.50 budget
    const fakeModel = {
      invoke: vi.fn().mockImplementation(async () => {
        const msg = new AIMessage({
          content: 'Model turn',
          tool_calls: [{
            id: 'call_run',
            name: 'run_script',
            args: { script: 'from build123d import *\nresult = Box(10, 10, 10)' },
          }],
        });
        // Model call uses 30,000 output tokens on Sonnet ($10/M) = $0.30
        msg.usage_metadata = {
          input_tokens: 10_000, // $0.02
          output_tokens: 30_000, // $0.30 -> $0.32 per call
          total_tokens: 40_000,
        };
        return msg;
      }),
    };

    vi.spyOn(brepRunner, 'runBrep').mockResolvedValue({
      ok: true,
      parts: [{ label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
      solids: 1,
      ms: 10,
    });

    const agentBuild = makeBrepAgentBuild(fakeModel as never);

    // Visit 1: starts with $0.30 already spent. One call adds $0.32 -> total $0.62 > $0.50!
    const stateVisit1 = {
      assemblySpec: resolveSpec({
        assemblyName: 'box',
        boundingBox: { width: 10, length: 10, height: 10 },
        components: [{ name: 'base', description: 'base box', localExtents: [10, 10, 10], position: [0, 0, 0], shape: { kind: 'box' } }],
      } as unknown as AssemblySpec).spec,
      currentCode: 'from build123d import *\nresult = Box(10, 10, 10)',
      attemptCount: 0,
      buildWallMs: 0,
      buildCostUsd: 0.30, // $0.30 from prior visit
      buildNotes: [],
      messages: [new HumanMessage('simple box')],
      failureKind: 'none',
    } as unknown as AgentStateType;

    const out1 = await agentBuild(stateVisit1);
    expect(out1.buildCostUsd).toBeGreaterThan(0.50);
    const budgetNote = out1.buildNotes?.find((n) => n.reason.includes('cost budget of $0.50 exceeded'));
    expect(budgetNote).toBeDefined();
    expect(out1.currentCode).toContain('Box(10, 10, 10)');
  });

  it('L2: missing usage metadata charges floor ($0.05) and bounds cost loop', async () => {
    process.env.CADAI_AGENT_MAX_USD = '0.08'; // $0.08 budget, floor is $0.05 so 2nd turn trips
    const fakeModel = {
      invoke: vi.fn().mockImplementation(async () => {
        return new AIMessage({
          content: 'No usage metadata here',
          tool_calls: [{
            id: 'call_run',
            name: 'run_script',
            args: { script: 'from build123d import *\nresult = Box(10, 10, 10)' },
          }],
        });
      }),
    };

    vi.spyOn(brepRunner, 'runBrep').mockResolvedValue({
      ok: true,
      parts: [{ label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
      solids: 1,
      ms: 10,
    });

    const agentBuild = makeBrepAgentBuild(fakeModel as never);
    const state = {
      assemblySpec: resolveSpec({
        assemblyName: 'box',
        boundingBox: { width: 10, length: 10, height: 10 },
        components: [{ name: 'base', description: 'base box', localExtents: [10, 10, 10], position: [0, 0, 0], shape: { kind: 'box' } }],
      } as unknown as AssemblySpec).spec,
      currentCode: 'from build123d import *\nresult = Box(10, 10, 10)',
      attemptCount: 0,
      buildWallMs: 0,
      buildCostUsd: 0,
      buildNotes: [],
      messages: [new HumanMessage('simple box')],
      failureKind: 'none',
    } as unknown as AgentStateType;

    const out = await agentBuild(state);
    // 1st turn charged $0.05 floor, 2nd turn charged $0.05 floor -> $0.10 > $0.08!
    expect(out.buildCostUsd).toBeGreaterThanOrEqual(0.08);
    const budgetNote = out.buildNotes?.find((n) => n.reason.includes('cost budget of $0.08 exceeded'));
    expect(budgetNote).toBeDefined();
  });

  it('L2: wall clock check before runBrep stops tool loop execution', async () => {
    process.env.CADAI_AGENT_MAX_WALL_S = '5';
    let callCount = 0;
    const fakeModel = {
      invoke: vi.fn().mockImplementation(async () => {
        return new AIMessage({
          content: 'Run then Finish',
          tool_calls: [
            {
              id: 'call_run',
              name: 'run_script',
              args: { script: 'from build123d import *\nresult = Box(10, 10, 10)' },
            },
          ],
        });
      }),
    };

    const runSpy = vi.spyOn(brepRunner, 'runBrep').mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        parts: [{ label: 'base', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
        solids: 1,
        ms: 10,
      };
    });
    runSpy.mockClear();

    const agentBuild = makeBrepAgentBuild(fakeModel as never);
    const state = {
      assemblySpec: resolveSpec({
        assemblyName: 'box',
        boundingBox: { width: 10, length: 10, height: 10 },
        components: [{ name: 'base', description: 'base box', localExtents: [10, 10, 10], position: [0, 0, 0], shape: { kind: 'box' } }],
      } as unknown as AssemblySpec).spec,
      currentCode: 'from build123d import *\nresult = Box(10, 10, 10)',
      attemptCount: 0,
      buildWallMs: 5_500, // already exceeded
      buildCostUsd: 0,
      buildNotes: [],
      messages: [new HumanMessage('simple box')],
      failureKind: 'none',
    } as unknown as AgentStateType;

    const out = await agentBuild(state);
    expect(callCount).toBe(0);
    expect(runSpy).not.toHaveBeenCalled();
    const budgetNote = out.buildNotes?.find((n) => n.reason.includes('wall time limit of 5s exceeded'));
    expect(budgetNote).toBeDefined();
  });
});
