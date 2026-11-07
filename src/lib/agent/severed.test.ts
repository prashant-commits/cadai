import { describe, it, expect, vi, afterAll } from 'vitest';
import { isInterrupted } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import type { AgentStateType } from './graph';
import type { AssemblySpec } from './assembly-spec';
import { composeAssembly } from '../design/compose-assembly';

const callMock = vi.fn();

vi.mock('@langchain/anthropic', () => {
  class FakeChatModel {
    invoke = (messages: unknown) => callMock(messages);
    async *stream(messages: unknown) { yield await callMock(messages); }
    withStructuredOutput() { return this; }
    withConfig() { return this; }
    bindTools() { return this; }
  }
  return { ChatAnthropic: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

import { createCadAgent } from './graph';

const keys: string[] = [];
let counter = 0;
const newKey = () => {
  const key = runCheckpointKey(`severed-${Date.now()}`, `run-${counter++}`);
  keys.push(key);
  return key;
};
afterAll(async () => {
  for (const key of keys) await getCheckpointer().deleteThread(key);
});

const spec = {
  sheet: '## Plate\nA plate',
  assemblyName: 'plate_spec',
  boundingBox: { width: 40, length: 10, height: 10 },
  components: [{ name: 'plate', description: 'a split plate', localExtents: [40, 10, 10], position: [0, 0, 0], shape: { kind: 'box' } }],
  assumptions: [],
  openQuestions: [],
};

function kindOf(messages: unknown): string {
  const text = JSON.stringify(messages);
  if (text.includes('Generate the Assembly Spec for Variant')) return 'variant';
  if (text.includes('Implement the Architect Spec below')) return 'drafter';
  if (text.includes('Mechanical Architect Planner')) return 'planner';
  return 'other';
}

describe('severed components', () => {
  it('carries a module shell count onto the placement report', () => {
    const code = 'module plate() { cube([10, 10, 10]); translate([30, 0, 0]) cube([10, 10, 10]); }\n';
    const frames = [{
      name: 'plate', valid: true, min: [0, 0, 0] as [number, number, number],
      max: [40, 10, 10] as [number, number, number], size: [40, 10, 10] as [number, number, number], shellCount: 2,
    }];
    const report = composeAssembly(code, spec as unknown as AssemblySpec, frames).report;
    expect((report?.components[0] as { shellCount?: number }).shellCount).toBe(2);
  });

  it('does not copy a shell count off a frame that was not measured', () => {
    const code = 'module plate() { cube([10, 10, 10]); }\n';
    const frames = [{
      name: 'plate', valid: false, min: [0, 0, 0] as [number, number, number],
      max: [0, 0, 0] as [number, number, number], size: [0, 0, 0] as [number, number, number],
      shellCount: 2, cavityCount: 1,
    }];
    const report = composeAssembly(code, spec as unknown as AssemblySpec, frames).report;
    const component = report?.components[0] as { shellCount?: number; cavityCount?: number };
    expect(component.shellCount).toBeUndefined();
    expect(component.cavityCount).toBeUndefined();
  });

  it('flags a component whose own module compiles to more than one shell', async () => {
    const saved = process.env.CADAI_MAX_ATTEMPTS;
    process.env.CADAI_MAX_ATTEMPTS = '1';
    callMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner':
          return { brief: 'Plan', assumptions: [], openQuestions: [], variants: [{ id: 'A', name: 'A', idea: 'plate' }], recommendedId: 'A' };
        case 'variant':
          return spec;
        case 'drafter':
          return { content: '```openscad\nmodule plate() { cube([10, 10, 10]); translate([30, 0, 0]) cube([10, 10, 10]); }\n```', tool_calls: [] };
        default:
          return { matchesRequest: true, findings: [] };
      }
    });
    try {
      const agent = createCadAgent('gpt-6-sol');
      const config = { configurable: { thread_id: newKey() } };
      const result = await agent.invoke({ messages: [new HumanMessage('a 40mm plate')] }, config);
      const state = (await agent.getState(config)).values as AgentStateType;
      const severed = (state.specViolations ?? []).filter((v) => v.kind === 'severed');
      expect(severed).toHaveLength(1);
      expect(severed[0].field).toBe('plate');
      expect(severed[0].severity).toBe('error');
      expect(severed[0].measured).toBe(2);
      expect(severed[0].message).toBe(
        'plate is cut into 2 separate pieces on its own - a cut runs through it. Stop the cut short of the edge or bridge the pieces.',
      );
      expect(state.isValid).toBe(false);
      expect(isInterrupted(result)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CADAI_MAX_ATTEMPTS;
      else process.env.CADAI_MAX_ATTEMPTS = saved;
    }
  });

  it('reports a sealed cavity instead of calling the part severed', async () => {
    const saved = process.env.CADAI_MAX_ATTEMPTS;
    process.env.CADAI_MAX_ATTEMPTS = '1';
    const box = {
      ...spec,
      assemblyName: 'closed_box',
      boundingBox: { width: 20, length: 20, height: 20 },
      components: [{ name: 'box', description: 'a closed box', localExtents: [20, 20, 20], position: [0, 0, 0], shape: { kind: 'box' } }],
    };
    callMock.mockImplementation(async (messages: unknown) => {
      switch (kindOf(messages)) {
        case 'planner':
          return { brief: 'Plan', assumptions: [], openQuestions: [], variants: [{ id: 'A', name: 'A', idea: 'box' }], recommendedId: 'A' };
        case 'variant':
          return box;
        case 'drafter':
          return {
            content: '```openscad\nmodule box() { difference() { cube([20, 20, 20]); translate([5, 5, 5]) cube([10, 10, 10]); } }\n```',
            tool_calls: [],
          };
        default:
          return { matchesRequest: true, findings: [] };
      }
    });
    try {
      const agent = createCadAgent('gpt-6-sol');
      const config = { configurable: { thread_id: newKey() } };
      await agent.invoke({ messages: [new HumanMessage('a 20mm box')] }, config);
      const state = (await agent.getState(config)).values as AgentStateType;
      const severed = (state.specViolations ?? []).filter((v) => v.kind === 'severed');
      const cavity = (state.specViolations ?? []).filter((v) => v.kind === 'sealed_cavity');
      expect(severed).toHaveLength(0);
      expect(cavity).toHaveLength(1);
      expect(cavity[0].field).toBe('box');
      expect(cavity[0].message).toBe(
        'box has a sealed cavity; run the cutter 0.02 mm past the face it should open.',
      );
    } finally {
      if (saved === undefined) delete process.env.CADAI_MAX_ATTEMPTS;
      else process.env.CADAI_MAX_ATTEMPTS = saved;
    }
  });
});
