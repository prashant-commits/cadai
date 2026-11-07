import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { getChatModel } from './model-provider';
import { makeBrepBuild } from './nodes/brep-build';
import { structuredFor, ArchitectPlanSchema, SheetReviewSchema } from './llm-schemas';
import { variantSpecRequestSchema } from './assembly-spec';
import { reply, withFakeClient, type Body } from './__fixtures__/fake-anthropic';
import type { AgentStateType } from './graph';

// CADAI_BUILD_THINKING / CADAI_BUILD_EFFORT: the code-writing build nodes get their own
// thinking and effort; every other node keeps the global setting.

const saved = { ...process.env };
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  for (const k of ['CADAI_MODEL', 'CADAI_MAX_TOKENS', 'CADAI_THINKING', 'CADAI_EFFORT', 'CADAI_BUILD_THINKING', 'CADAI_BUILD_EFFORT']) delete process.env[k];
});
afterEach(() => {
  process.env = { ...saved };
});

const BODY = '@body plate\nreturn Box(10, 10, 5, align=(Align.MIN, Align.MIN, Align.MIN))\n@end';
const SPEC = {
  assemblyName: 'plate',
  boundingBox: { width: 10, length: 10, height: 5 },
  components: [{ name: 'plate', description: 'a plate', localExtents: [10, 10, 5], position: [0, 0, 0], shape: { kind: 'box' } }],
  assumptions: [],
  openQuestions: [],
};
const buildState = () =>
  ({
    assemblySpec: SPEC, attemptCount: 0, currentCode: '', attemptHistory: [], messages: [],
    gateAction: null, gateFeedback: null, failureKind: 'none',
  }) as unknown as AgentStateType;

/** The request body of one brepBuild visit on `slug`, with `role` on its model. */
async function brepBuildBody(slug: string, role?: 'build'): Promise<Body> {
  const model = getChatModel(slug, role ? { role } : undefined);
  const bodies = withFakeClient(model, () => reply([{ type: 'text', text: BODY }]));
  await makeBrepBuild(model)(buildState());
  return bodies[0];
}

/** Request bodies of the planner, a variant spec and the reviewer, all on the global (role-less) model. */
async function otherNodeBodies(slug: string): Promise<Body[]> {
  const plan = { brief: 'b', assumptions: [], openQuestions: [], variants: [{ id: 'A', name: 'Cube', idea: 'a cube' }], recommendedId: 'A' };
  const review = { matchesRequest: true, findings: [] };
  const bodies: Body[] = [];
  const run = async (schema: Parameters<typeof structuredFor>[2], name: string, answer: unknown[]) => {
    const model = getChatModel(slug);
    const sent = withFakeClient(model, () => reply(answer));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (structuredFor(model, slug, schema, { name, strict: true }) as any).invoke([new HumanMessage('a cube')]);
    bodies.push(...sent);
  };
  await run(ArchitectPlanSchema, 'ArchitectPlan', [{ type: 'text', text: JSON.stringify(plan) }]);
  await run(variantSpecRequestSchema(), 'AssemblySpec', [{ type: 'tool_use', id: 'toolu_v', name: 'AssemblySpec', input: SPEC }]);
  await run(SheetReviewSchema, 'SheetReview', [{ type: 'text', text: JSON.stringify(review) }]);
  return bodies;
}

describe('role-aware build model', () => {
  it('CADAI_THINKING=off + CADAI_BUILD_THINKING=adaptive: only the build request thinks, at the build effort', async () => {
    process.env.CADAI_THINKING = 'off';
    process.env.CADAI_EFFORT = 'high';
    process.env.CADAI_BUILD_THINKING = 'adaptive';
    process.env.CADAI_BUILD_EFFORT = 'medium';

    const build = await brepBuildBody('claude-haiku-5.5', 'build');
    expect(build.thinking).toEqual({ type: 'adaptive' });
    expect(build.output_config).toEqual({ effort: 'medium' });
    expect(build.max_tokens).toBe(64000); // covers the thinking

    const others = await otherNodeBodies('claude-haiku-5.5');
    expect(others).toHaveLength(3);
    for (const b of others) {
      expect(b.thinking).toEqual({ type: 'disabled' });
      expect(b.output_config.effort).toBe('high');
      expect(b.max_tokens).toBe(32000);
    }
  });

  it('unset build variables inherit the global ones', async () => {
    process.env.CADAI_THINKING = 'adaptive';
    process.env.CADAI_EFFORT = 'low';
    const adaptive = await brepBuildBody('claude-haiku-5.5', 'build');
    expect(adaptive.thinking).toEqual({ type: 'adaptive' });
    expect(adaptive.output_config).toEqual({ effort: 'low' });

    process.env.CADAI_THINKING = 'off';
    process.env.CADAI_EFFORT = 'medium';
    const off = await brepBuildBody('claude-haiku-5.5', 'build');
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.output_config).toEqual({ effort: 'medium' });
    expect(off.max_tokens).toBe(32000);
  });

  it('the build variables can also turn thinking off (and lower effort) under a global adaptive setting', async () => {
    process.env.CADAI_THINKING = 'adaptive';
    process.env.CADAI_BUILD_THINKING = 'off';
    const build = await brepBuildBody('claude-haiku-5.5', 'build');
    expect(build.thinking).toEqual({ type: 'disabled' });
    const global = await brepBuildBody('claude-haiku-5.5');
    expect(global.thinking).toEqual({ type: 'adaptive' });
  });

  it('a role-less model ignores the build variables', async () => {
    process.env.CADAI_BUILD_THINKING = 'adaptive';
    process.env.CADAI_BUILD_EFFORT = 'low';
    const body = await brepBuildBody('claude-haiku-5.5');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('keeps the per-model fallback: Sonnet and Opus cannot disable thinking, even for the build role', async () => {
    process.env.CADAI_BUILD_THINKING = 'off';
    process.env.CADAI_BUILD_EFFORT = 'high';
    for (const slug of ['claude-sonnet-5.5', 'claude-opus-5.5']) {
      const body = await brepBuildBody(slug, 'build');
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'low' });
      expect(body.max_tokens).toBe(64000);
    }
  });

  it('an invalid build value falls back to the global setting with a warning', async () => {
    process.env.CADAI_THINKING = 'adaptive';
    process.env.CADAI_BUILD_THINKING = 'max';
    const body = await brepBuildBody('claude-haiku-5.5', 'build');
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });
});
