import { ToolMessage, type AIMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { getFunctionalCadModuleTool } from './engineering-tools';
import { extractOpenScadCode } from './code-extractor';
import { isCutOff, unusableStop } from './llm-schemas';

/** The slice of ChatAnthropic the tool round needs; graph tests pass a fake with the same shape. */
interface ToolBindable {
  bindTools(
    tools: unknown[],
    kwargs?: { tool_choice?: 'auto' | 'none' }
  ): { invoke(messages: BaseMessage[], config?: RunnableConfig): Promise<AIMessage | AIMessageChunk> };
}

const TOOLS = [getFunctionalCadModuleTool];

/** The result of one tool call, as the tool_result the Messages API requires for every tool_use. */
async function runToolCall(
  call: NonNullable<AIMessage['tool_calls']>[number],
  config?: RunnableConfig
): Promise<ToolMessage> {
  const id = call.id ?? '';
  if (call.name !== getFunctionalCadModuleTool.name) {
    return new ToolMessage({ tool_call_id: id, name: call.name, status: 'error', content: `Unknown tool "${call.name}".` });
  }
  try {
    // `config` parents the tool run to the node's span, so the retrieval shows
    // up in tracing when a draft comes back with the wrong hardware module.
    const result = await getFunctionalCadModuleTool.invoke(
      call.args as unknown as Parameters<typeof getFunctionalCadModuleTool.invoke>[0],
      config
    );
    return new ToolMessage({
      tool_call_id: id,
      name: call.name,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    });
  } catch (e) {
    return new ToolMessage({
      tool_call_id: id,
      name: call.name,
      status: 'error',
      content: `Tool error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/**
 * One drafter or repair turn with the engineering-module tool: the model may
 * call it once, then answers with the tool results in view.
 *
 * The follow-up runs on the SAME tools: the native Messages API rejects a
 * request whose history holds tool_use / tool_result blocks but defines no
 * tools. It binds them with `tool_choice: none`, so the second reply is the
 * script rather than another round of calls. Every tool_use gets a tool_result
 * (an error result for an unknown tool or bad arguments), which the API also
 * requires.
 */
export async function invokeWithToolRound(
  model: ToolBindable,
  messages: BaseMessage[],
  config?: RunnableConfig
): Promise<AIMessage | AIMessageChunk> {
  const first = await model.bindTools(TOOLS).invoke(messages, config);
  const calls = first.tool_calls ?? [];
  if (calls.length === 0) return first;

  const results: ToolMessage[] = [];
  for (const call of calls) results.push(await runToolCall(call, config));
  return model.bindTools(TOOLS, { tool_choice: 'none' }).invoke([...messages, first, ...results], config);
}

/**
 * The script in a drafter or repair reply. A reply that stopped short (max_tokens,
 * context window, pause) counts as truncated even when its fences happen to
 * balance, and a refusal as no code: both go to the existing truncated / no_code
 * path instead of compiling a script that was never finished.
 */
export function extractReplyCode(response: unknown, content: string): ReturnType<typeof extractOpenScadCode> {
  const stop = unusableStop(response);
  if (stop === 'refusal') return { code: null, error: 'no_code' };
  if (isCutOff(stop)) {
    console.warn(`script reply cut off (stop_reason ${stop}); treated as truncated`);
    return { code: null, error: 'truncated' };
  }
  return extractOpenScadCode(content);
}
