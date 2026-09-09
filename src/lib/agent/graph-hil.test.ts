import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { isInterrupted, INTERRUPT, Command } from '@langchain/langgraph';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { getCheckpointer, runCheckpointKey } from './checkpointer';

// createCadAgent talks to Gemini through @langchain/google-genai. Every
// invoke() call across architect/drafter/fix goes through the SAME mocked
// instance (withStructuredOutput/bindTools both return `this`), so a test
// queues canned responses in the exact order the graph is expected to call
// them - matching the ordering asserted by each scenario below.
const invokeMock = vi.fn();

vi.mock('@langchain/google-genai', () => {
  class FakeChatModel {
    invoke = invokeMock;
    withStructuredOutput() { return this; }
    bindTools() { return this; }
  }
  // Arrow functions have no [[Construct]] slot, so `new ChatGoogleGenerativeAI(...)`
  // inside getGeminiModel requires a real constructible mock, not vi.fn(() => ...).
  return { ChatGoogleGenerativeAI: vi.fn().mockImplementation(function () { return new FakeChatModel(); }) };
});

import { createCadAgent } from './graph';

function baseSpec(overrides: Record<string, any> = {}) {
  return {
    assemblyName: 'test_box',
    boundingBox: { width: 40, length: 40, height: 40 },
    components: [{ name: 'box', description: 'a box' }],
    assumptions: [],
    openQuestions: [],
    ...overrides,
  };
}

function draftResponse(code: string) {
  return { content: `\`\`\`openscad\n${code}\n\`\`\``, tool_calls: [] };
}

// createCadAgent() has no way to inject a test checkpointer - it always
// resolves to the SAME getCheckpointer() singleton the live dev server
// uses (process.cwd()/.cadai/checkpoints.json). Track every thread this
// file creates and delete them afterward so test runs don't leave junk
// threads in a real checkpoint store shared with a running dev server.
const createdThreadIds: string[] = [];
let threadCounter = 0;
function newThreadId() {
  const id = `hil-test-${Date.now()}-${threadCounter++}`;
  createdThreadIds.push(id);
  return id;
}

// The checkpoint key for one run of `threadId`, mirroring what /api/chat does
// per request. Registered for cleanup like any other key.
function newRunKey(threadId: string) {
  const key = runCheckpointKey(threadId, `run-${threadCounter++}`);
  createdThreadIds.push(key);
  return key;
}

// Every message a mocked model invocation was handed, as plain strings.
function contentsOf(call: number) {
  return (invokeMock.mock.calls[call][0] as any[]).map((m) => String(m.content));
}

afterAll(async () => {
  const checkpointer = getCheckpointer();
  for (const id of createdThreadIds) {
    await checkpointer.deleteThread(id);
  }
  // deleteThread's flush() is debounced (100ms) and fire-and-forget - without
  // this, afterAll can return (and the process exit) before the deletions
  // are ever written to disk, leaving every "cleaned up" thread still in the
  // live checkpoints.json.
  await new Promise((resolve) => setTimeout(resolve, 200));
});

// The compiled graph's own StateType doesn't declare `__interrupt__` - it's
// bolted on by LangGraph's runtime at invoke() time, not part of AgentState.
function gatePayload(result: any) {
  return result[INTERRUPT][0].value;
}

describe('HIL gating (interrupt/resume)', () => {
  // These tests assert on exact model-call counts to prove routing. The visual
  // critic adds one multimodal call to every successful run, which is covered
  // by its own suite (graph-critic.test.ts) - leaving it on here would make
  // every count in this file a statement about two unrelated things at once.
  beforeEach(() => {
    process.env.CADAI_VISUAL_CRITIC = 'off';
    invokeMock.mockReset();
  });

  afterAll(() => {
    delete process.env.CADAI_VISUAL_CRITIC;
  });

  it('pauses at the spec gate with a real payload, and an edited+approved spec becomes the enforced contract', async () => {
    // Architect proposes a spec with an assumption, forcing the gate
    // regardless of prompt wording (deterministic, no prompt-parsing needed).
    invokeMock.mockResolvedValueOnce(
      baseSpec({ assumptions: [{ field: 'wall_thickness', value: '2.4mm', rationale: 'default FDM wall' }] })
    );

    const agent = createCadAgent('test-key', undefined, 'test-model');
    const threadId = newThreadId();
    const config = { configurable: { thread_id: threadId } };

    const result = await agent.invoke(
      { messages: [new HumanMessage('a box')] },
      config
    );

    expect(isInterrupted(result)).toBe(true);
    const payload = gatePayload(result);
    expect(payload.kind).toBe('spec');
    expect(payload.spec.assumptions).toHaveLength(1);

    // Approve with an EDITED spec - width changed from 40 to 55.
    const editedSpec = baseSpec({ boundingBox: { width: 55, length: 40, height: 40 } });
    invokeMock.mockResolvedValueOnce(draftResponse('cube([55,40,40]);'));

    const resumed = await agent.invoke(
      new Command({ resume: { action: 'approve', spec: editedSpec } }),
      config
    );

    expect(isInterrupted(resumed)).toBe(false);
    expect(resumed.assemblySpec?.boundingBox.width).toBe(55);
    expect(resumed.assemblySpec?.specApprovedAt).toBeTruthy();
    expect(resumed.designContract?.specApprovedAt).toBeTruthy();
    expect(resumed.isValid).toBe(true);
  });

  it('rejects a malformed edited spec and falls back to the last known-good one', async () => {
    invokeMock.mockResolvedValueOnce(baseSpec({ assumptions: [{ field: 'x', value: 'y', rationale: 'z' }] }));

    const agent = createCadAgent('test-key', undefined, 'test-model');
    const threadId = newThreadId();
    const config = { configurable: { thread_id: threadId } };

    await agent.invoke({ messages: [new HumanMessage('a box')] }, config);

    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

    // Missing required `boundingBox` - fails AssemblySpecSchema.safeParse.
    const resumed = await agent.invoke(
      new Command({ resume: { action: 'approve', spec: { assemblyName: 'broken' } as any } }),
      config
    );

    expect(resumed.assemblySpec?.boundingBox).toEqual({ width: 40, length: 40, height: 40 });
    expect(resumed.assemblySpec?.specApprovedAt).toBeTruthy();
  });

  it('revise loops back to the architect with the human feedback, capped, then proceeds', async () => {
    // First pass: gated by an assumption.
    invokeMock.mockResolvedValueOnce(baseSpec({ assumptions: [{ field: 'x', value: 'y', rationale: 'z' }] }));

    const agent = createCadAgent('test-key', undefined, 'test-model');
    const threadId = newThreadId();
    const config = { configurable: { thread_id: threadId } };

    // Prompt carries an explicit dimension so that once the revised spec has
    // no assumptions/components>1/joints, shouldGateSpec stops firing.
    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    // Second architect pass (post-revise): no assumptions this time. Then
    // the run proceeds straight through drafting to a clean compile.
    invokeMock.mockResolvedValueOnce(baseSpec());
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

    const afterRevise = await agent.invoke(
      new Command({ resume: { action: 'revise', comment: 'use M4 bolts, not M3' } }),
      config
    );

    // Architect was re-invoked (2nd call), then the run proceeded through
    // drafting (3rd call) since the revised spec no longer gates.
    expect(invokeMock).toHaveBeenCalledTimes(3);
    const secondCallMessages = invokeMock.mock.calls[1][0] as any[];
    const sawFeedback = secondCallMessages.some(
      (m) => typeof m.content === 'string' && m.content.includes('use M4 bolts, not M3')
    );
    expect(sawFeedback).toBe(true);

    // No second SPEC gate this time (spec has no assumptions and the prompt
    // has a dimension) - the run proceeds through drafting and validation,
    // which needs its own queued response.
    expect(isInterrupted(afterRevise)).toBe(false);
    expect(afterRevise.isValid).toBe(true);
  });

  it('cancel at the spec gate stops the run and deletes the checkpoint', async () => {
    invokeMock.mockResolvedValueOnce(baseSpec({ assumptions: [{ field: 'x', value: 'y', rationale: 'z' }] }));

    const agent = createCadAgent('test-key', undefined, 'test-model');
    const threadId = newThreadId();
    const config = { configurable: { thread_id: threadId } };

    await agent.invoke({ messages: [new HumanMessage('a box')] }, config);

    const resumed = await agent.invoke(new Command({ resume: { action: 'cancel' } }), config);

    expect(isInterrupted(resumed)).toBe(false);
    // Cancel routes straight to respondToUser without drafting/validating.
    expect(resumed.currentCode).toBe('');
    expect(invokeMock).toHaveBeenCalledTimes(1); // architect only, never drafter
  });

  it('gates at accept after a repair, and revise routes back into fixCode with a bumped attempt budget', async () => {
    // No assumptions/joints/multi-component, and the prompt has a dimension,
    // so the spec gate never fires - this run goes straight to drafting.
    invokeMock.mockResolvedValueOnce(baseSpec());
    // Drafter emits broken syntax, forcing a repair.
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40);'));
    // Repair produces valid code.
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

    const agent = createCadAgent('test-key', undefined, 'test-model');
    const threadId = newThreadId();
    const config = { configurable: { thread_id: threadId } };

    const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    // attemptCount > 1 (a repair happened) triggers the accept gate even
    // though the repaired code is fully valid.
    expect(isInterrupted(result)).toBe(true);
    const payload = gatePayload(result);
    expect(payload.kind).toBe('accept');
    expect(payload.modelInfo?.isWatertight).toBe(true);

    const maxAttemptsBefore = (await agent.getState(config)).values.maxAttempts;

    // Human asks for one more real repair pass instead of accepting.
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,45]);'));

    const afterRevise = await agent.invoke(
      new Command({ resume: { action: 'revise', comment: 'make it 45mm tall' } }),
      config
    );

    // The revise decision reached fixCode's own prompt.
    const fixCallMessages = invokeMock.mock.calls[3][0] as any[];
    const sawFeedback = fixCallMessages.some(
      (m) => typeof m.content === 'string' && m.content.includes('make it 45mm tall')
    );
    expect(sawFeedback).toBe(true);

    const stateAfter = await agent.getState(config);
    expect(stateAfter.values.maxAttempts).toBe(maxAttemptsBefore + 1);

    // attemptCount is now 3 (cumulative, not per-round), so shouldGateAccept's
    // `attemptCount > 1` policy correctly re-gates: a run that has ever
    // needed a repair keeps the human in the loop until they explicitly
    // approve, rather than auto-accepting the very next compile.
    expect(isInterrupted(afterRevise)).toBe(true);
    const secondAcceptPayload = gatePayload(afterRevise);
    expect(secondAcceptPayload.kind).toBe('accept');

    const finalResult = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    expect(isInterrupted(finalResult)).toBe(false);
    expect(finalResult.isValid).toBe(true);
  });

  // Regression guard for the quality drop that arrived with HIL. Every other
  // test here uses one fresh checkpoint per test, which is exactly the case
  // that never broke; these reuse a chat thread across turns the way the UI
  // does, which is where state leaked.
  describe('turn isolation', () => {
    it('does not replay one turn of a chat thread into the next', async () => {
      const agent = createCadAgent('test-key', undefined, 'test-model');
      const chatThreadId = newThreadId();

      // TURN 1: no assumptions and a dimension in the prompt, so no gate.
      invokeMock.mockResolvedValueOnce(baseSpec());
      invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
      await agent.invoke(
        { messages: [new HumanMessage('a 40mm box')] },
        { configurable: { thread_id: newRunKey(chatThreadId) } }
      );

      // TURN 2: same chat thread, new run. The client re-sends the whole
      // conversation, exactly as chat-panel.tsx does.
      invokeMock.mockClear();
      invokeMock.mockResolvedValueOnce(baseSpec({ boundingBox: { width: 80, length: 80, height: 80 } }));
      invokeMock.mockResolvedValueOnce(draftResponse('cube([80,80,80]);'));
      await agent.invoke(
        {
          messages: [
            new HumanMessage('a 40mm box'),
            new AIMessage('Here is your 40mm box.'),
            new HumanMessage('now make it 80mm'),
          ],
        },
        { configurable: { thread_id: newRunKey(chatThreadId) } }
      );

      const architectSaw = contentsOf(0);

      // The client's history is ALL the architect gets: one copy per turn.
      // Two copies meant the checkpoint was replaying turn 1 underneath it.
      expect(architectSaw.filter((c) => c.includes('a 40mm box'))).toHaveLength(1);

      // Turn 1's internals must not reappear as conversation.
      expect(architectSaw.some((c) => c.includes('[Validation Report]'))).toBe(false);
      expect(architectSaw.some((c) => c.includes('cube([40,40,40])'))).toBe(false);
    });

    it('does not carry a gate decision from one turn into the next', async () => {
      const agent = createCadAgent('test-key', undefined, 'test-model');
      const chatThreadId = newThreadId();
      const turn1 = { configurable: { thread_id: newRunKey(chatThreadId) } };

      // TURN 1 gates on an assumption, and the human revises with very
      // specific feedback before the run completes.
      invokeMock.mockResolvedValueOnce(baseSpec({ assumptions: [{ field: 'x', value: 'y', rationale: 'z' }] }));
      await agent.invoke({ messages: [new HumanMessage('a 40mm bracket')] }, turn1);

      invokeMock.mockResolvedValueOnce(baseSpec());
      invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
      await agent.invoke(
        new Command({ resume: { action: 'revise', comment: 'USE M4 BOLTS NOT M3' } }),
        turn1
      );

      // The decision is spent the moment its consumer runs - it must not sit
      // in state waiting to be re-read.
      const settled = (await agent.getState(turn1)).values;
      expect(settled.gateAction).toBeNull();
      expect(settled.gateFeedback).toBeNull();

      // TURN 2 is an unrelated request on the same chat thread.
      invokeMock.mockClear();
      invokeMock.mockResolvedValueOnce(
        baseSpec({ assemblyName: 'phone_stand', boundingBox: { width: 90, length: 60, height: 10 } })
      );
      invokeMock.mockResolvedValueOnce(draftResponse('cube([90,60,10]);'));
      await agent.invoke(
        {
          messages: [
            new HumanMessage('a 40mm bracket'),
            new AIMessage('Here is your bracket.'),
            new HumanMessage('now design a 90mm phone stand'),
          ],
        },
        { configurable: { thread_id: newRunKey(chatThreadId) } }
      );

      expect(contentsOf(0).some((c) => c.includes('USE M4 BOLTS NOT M3'))).toBe(false);
    });

    it('sends the drafter exactly one Assembly Spec after a revise loop', async () => {
      const agent = createCadAgent('test-key', undefined, 'test-model');
      const config = { configurable: { thread_id: newRunKey(newThreadId()) } };

      // Architect pass 1: gates, and proposes a 40mm box.
      invokeMock.mockResolvedValueOnce(
        baseSpec({ assumptions: [{ field: 'x', value: 'y', rationale: 'z' }] })
      );
      await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

      // Architect pass 2: the revised spec is 55mm wide and no longer gates.
      invokeMock.mockResolvedValueOnce(baseSpec({ boundingBox: { width: 55, length: 40, height: 40 } }));
      invokeMock.mockResolvedValueOnce(draftResponse('cube([55,40,40]);'));
      await agent.invoke(
        new Command({ resume: { action: 'revise', comment: 'make it 55 wide' } }),
        config
      );

      // Call 2 is the drafter. Exactly one spec reaches it, and it is the
      // revised one - the superseded 40mm spec must not still be in context.
      const drafterSaw = contentsOf(2);
      expect(drafterSaw.filter((c) => c.includes('Architect Spec:'))).toHaveLength(1);
      expect(drafterSaw.some((c) => c.includes('"width": 55'))).toBe(true);
      expect(drafterSaw.some((c) => c.includes('"width": 40'))).toBe(false);

      // And no spec is left behind in the accumulated history either.
      const state = (await agent.getState(config)).values;
      expect(state.messages.some((m: any) => String(m.content).includes('"assemblyName"'))).toBe(false);
    });
  });

  it('gives a semantic failure its own repair pass after compile failures burned attempts', async () => {
    const agent = createCadAgent('test-key', undefined, 'test-model');
    const config = { configurable: { thread_id: newRunKey(newThreadId()) } };

    // No gate: single component, no assumptions, dimension in the prompt.
    invokeMock.mockResolvedValueOnce(baseSpec());
    // Attempt 1: broken syntax -> compile failure.
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40);'));
    // Attempt 2: compiles, but 90mm against a 40mm spec -> semantic failure.
    // Under the old shared counter this was attemptCount === 2, which tripped
    // `semantic && attemptCount >= 2` and ended the run with the dimensional
    // error unrepaired.
    invokeMock.mockResolvedValueOnce(draftResponse('cube([90,90,90]);'));
    // Attempt 3: the geometric repair that used to never happen.
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

    const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    // architect + draft + 2 repairs. Three calls would mean the semantic
    // failure was dropped without a repair attempt.
    expect(invokeMock).toHaveBeenCalledTimes(4);

    const state = (await agent.getState(config)).values;
    expect(state.compileFailures).toBe(1);
    expect(state.semanticFailures).toBe(1);
    expect(state.isValid).toBe(true);

    // A run that needed repairs still ends at the accept gate for sign-off.
    expect(isInterrupted(result)).toBe(true);
    expect(gatePayload(result).kind).toBe('accept');
  });

  it('names the failure class in the repair prompt instead of "compilation or geometry"', async () => {
    const agent = createCadAgent('test-key', undefined, 'test-model');
    const config = { configurable: { thread_id: newRunKey(newThreadId()) } };

    invokeMock.mockResolvedValueOnce(baseSpec());
    invokeMock.mockResolvedValueOnce(draftResponse('cube([90,90,90]);')); // compiles, wrong size
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    // Call 2 is the repair. It must be told the script compiled, so it does
    // not go hunting for a syntax error that isn't there.
    const repairPrompt = contentsOf(2).join('\n');
    expect(repairPrompt).toContain('COMPILED SUCCESSFULLY');
    expect(repairPrompt).toContain('GEOMETRY error');
    expect(repairPrompt).not.toContain('compilation or geometry error');
  });

  it('hands the repair node the flat-face and overhang measurements, led by the dominant violation', async () => {
    const agent = createCadAgent('test-key', undefined, 'test-model');
    const config = { configurable: { thread_id: newRunKey(newThreadId()) } };

    invokeMock.mockResolvedValueOnce(baseSpec());
    invokeMock.mockResolvedValueOnce(draftResponse('cube([90,90,90]);')); // compiles, wrong size
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));

    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    const repairPrompt = contentsOf(2).join('\n');
    // Numbers analyzeStl always computed but the repair prompt never carried.
    expect(repairPrompt).toContain('bottom area');
    expect(repairPrompt).toContain('flat-packable');
    expect(repairPrompt).toContain('max overhang');
    // The semantic class is broad; the header names the one violation to fix.
    expect(repairPrompt).toContain('Lead with the [bbox] violation');
  });

  it('shows the drafter the edge treatments, stress points and design contract it is graded on', async () => {
    const agent = createCadAgent('test-key', undefined, 'test-model');
    const config = { configurable: { thread_id: newRunKey(newThreadId()) } };

    invokeMock.mockResolvedValueOnce(
      baseSpec({
        components: [{ name: 'box', description: 'a box', bedFace: '-Z', matingFaces: ['+Z (lid seat)'] }],
        edgeTreatments: [
          { location: 'bed perimeter', category: 'printability', kind: 'chamfer', sizeMm: 0.4 },
        ],
        stressPoints: [
          { location: 'floor/wall junction', loadCase: '20 N bending', risk: 'high', mitigation: 'R1.2 fillet' },
        ],
      })
    );
    invokeMock.mockResolvedValueOnce(draftResponse('wall_t = 2.4;\ncube([40,40,40]);'));

    await agent.invoke(
      {
        messages: [new HumanMessage('a 40mm box')],
        designContract: {
          standing: { nozzleMm: 0.4 },
          pinnedParams: { wall_t: { value: 2.4, supersededValue: 2, pinnedAt: 1 } },
        },
      },
      config
    );

    // Call 1 is the drafter. The spec JSON must reach it whole, and the
    // contract it is audited against must be spelled out rather than implied.
    const drafterPrompt = contentsOf(1).join('\n');
    expect(drafterPrompt).toContain('"category": "printability"');
    expect(drafterPrompt).toContain('R1.2 fillet');
    expect(drafterPrompt).toContain('"bedFace": "-Z"');
    expect(drafterPrompt).toContain('wall_t = 2.4;');
    expect(drafterPrompt).toContain('Minimum wall thickness: 1.6mm');

    // The user-facing summary surfaces the same decisions without the JSON.
    const state = (await agent.getState(config)).values;
    expect(state.explanation).toContain('Edge treatment [printability] chamfer 0.4mm');
    expect(state.explanation).toContain('Stress point [high]');
    expect(state.explanation).toContain('bed face -Z');
  });

  it('folds answered open questions into the spec as assumptions on approve', async () => {
    const agent = createCadAgent('test-key', undefined, 'test-model');
    const config = { configurable: { thread_id: newRunKey(newThreadId()) } };

    invokeMock.mockResolvedValueOnce(
      baseSpec({
        openQuestions: [
          { id: 'q1', question: 'What bolt size?', suggestedAnswer: 'M3' },
          { id: 'q2', question: 'Wall thickness?', suggestedAnswer: '2.4mm' },
        ],
      })
    );
    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    const resumed = await agent.invoke(
      // q1 answered, q2 deliberately left blank.
      new Command({ resume: { action: 'approve', answers: { q1: 'M4' } } }),
      config
    );

    const spec = resumed.assemblySpec!;
    // The answer is now a settled fact the drafter and the audit both see.
    expect(spec.assumptions).toContainEqual({
      field: 'What bolt size?',
      value: 'M4',
      rationale: 'Answered by the user at the spec gate.',
    });
    // Answered questions are consumed; unanswered ones survive to be re-asked.
    expect(spec.openQuestions.map((q) => q.id)).toEqual(['q2']);
  });

  it('carries gate answers into the architect prompt on revise', async () => {
    const agent = createCadAgent('test-key', undefined, 'test-model');
    const config = { configurable: { thread_id: newRunKey(newThreadId()) } };

    invokeMock.mockResolvedValueOnce(
      baseSpec({ openQuestions: [{ id: 'q1', question: 'What bolt size?', suggestedAnswer: 'M3' }] })
    );
    await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);

    invokeMock.mockResolvedValueOnce(baseSpec());
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);'));
    await agent.invoke(
      new Command({ resume: { action: 'revise', comment: 'thinner walls', answers: { q1: 'M4' } } }),
      config
    );

    // The re-invoked architect must see BOTH the free-text comment and the
    // answer - previously only the comment survived.
    const architectPrompt = contentsOf(1).join('\n');
    expect(architectPrompt).toContain('thinner walls');
    expect(architectPrompt).toContain('What bolt size?');
    expect(architectPrompt).toContain('M4');
  });

  it('approving at the accept gate proceeds straight to respondToUser', async () => {
    invokeMock.mockResolvedValueOnce(baseSpec());
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40);')); // broken
    invokeMock.mockResolvedValueOnce(draftResponse('cube([40,40,40]);')); // repaired

    const agent = createCadAgent('test-key', undefined, 'test-model');
    const threadId = newThreadId();
    const config = { configurable: { thread_id: threadId } };

    const result = await agent.invoke({ messages: [new HumanMessage('a 40mm box')] }, config);
    expect(isInterrupted(result)).toBe(true);

    const resumed = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
    expect(isInterrupted(resumed)).toBe(false);
    expect(resumed.isValid).toBe(true);
  });
});
