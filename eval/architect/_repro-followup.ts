// Throwaway repro (deleted after debugging): finish a design, then send a follow-up message on the same thread.
import { HumanMessage } from '@langchain/core/messages';
for (const f of ['.env', '.env.local']) {
  try { process.loadEnvFile(f); } catch { /* absent */ }
}
process.env.CADAI_MAX_VARIANTS = '1';
import { Command, INTERRUPT, isInterrupted } from '@langchain/langgraph';
import { createCadAgent, type AgentStateType } from '@/lib/agent/graph';
import { runCheckpointKey } from '@/lib/agent/checkpointer';
import type { GatePayload } from '@/types';

const FIRST = 'A pen holder: a square base 80 x 80 mm with four upright tubes of 20 mm inner diameter, 100 mm tall, standing on the base.';
const SECOND = process.argv[2] ?? 'Make the tubes 150 mm tall.';

async function drive(agent: ReturnType<typeof createCadAgent>, input: unknown, config: object, label: string) {
  let result = await agent.invoke(input as never, config);
  for (let i = 0; i < 8 && isInterrupted<GatePayload>(result); i++) {
    const kind = result[INTERRUPT][0]?.value?.kind;
    console.log(`${label}: gate ${kind} -> approve`);
    result = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
  }
  const s = (await agent.getState(config)).values as AgentStateType;
  const tubes = (s.assemblySpec?.components ?? []).filter((c) => /tube/.test(c.name)).map((c) => c.localExtents?.join('x'));
  console.log(`${label}: spec=${s.assemblySpec?.assemblyName} tubes=${JSON.stringify(tubes)} variants=${s.specVariants?.length} attempt=${s.attemptCount} codeLen=${s.currentCode?.length} msgs=${s.messages?.length}`);
  console.log(`${label}: last message: ${String(s.messages?.at(-1)?.content).slice(0, 200)}`);
  return s;
}

(async () => {
  const agent = createCadAgent('claude-haiku-5.5');
  const config = { configurable: { thread_id: runCheckpointKey('repro', `followup-${Date.now()}`) }, recursionLimit: 200 };
  await drive(agent, { messages: [new HumanMessage(FIRST)] }, config, 'turn 1');
  await drive(agent, { messages: [new HumanMessage(SECOND)] }, config, 'turn 2');
})();
