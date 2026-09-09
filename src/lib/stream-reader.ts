import { AgentProgress, DesignContract } from '@/types';

export const readStream = async (
  response: Response,
  targetThreadId: string,
  callbacks: {
    onProgress: (progressItem: AgentProgress) => void;
    onFinalize: (
      finalCode: string,
      finalExplanation: string,
      finalStl: string,
      currentProgressList: AgentProgress[],
      finalContract?: DesignContract
    ) => void;
  }
) => {
  if (!response.body) throw new Error('No response stream received.');
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let buffer = '';
  let finalCode = '';
  let finalExplanation = '';
  let finalStl = '';
  // The approved spec + pins as the server last saw them. Without carrying
  // this back, everything the human confirmed at the spec gate is discarded
  // when the run ends and the next turn re-derives it from scratch.
  let finalContract: DesignContract | undefined;
  // A run that paused at a gate has not produced a final answer. The server
  // closes the stream right after emitting awaiting_input, so without this the
  // loop below would fall through and "finalize" an empty result - appending a
  // bogus "Model generation completed." message underneath the open gate.
  // Tracking it here fixes every caller at once; both call-site guards were
  // broken (one read a stale useState closure, the other read an
  // activeProgress that the awaiting_input branch never sets).
  let awaitingInput = false;
  const currentProgressList: AgentProgress[] = [];

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.substring(6);
          try {
            const event = JSON.parse(dataStr);

            const progressItem: AgentProgress = {
              id: 'progress-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
              type: event.type,
              message: event.message,
              timestamp: event.timestamp || Date.now(),
              details: event.details,
              gate: event.gate,
              runId: event.runId,
            };

            currentProgressList.push(progressItem);
            callbacks.onProgress(progressItem);

            if (event.type === 'ready') {
              if (event.code) finalCode = event.code;
              if (event.stl) finalStl = event.stl;
              if (event.designContract) finalContract = event.designContract;
              finalExplanation = event.explanation || event.message;
              // A resumed run that reaches 'ready' really has finished, even
              // if it paused earlier in this same stream.
              awaitingInput = false;
            } else if (event.type === 'error') {
              finalExplanation = event.explanation || event.message;
              awaitingInput = false;
            } else if (event.type === 'awaiting_input') {
              awaitingInput = true;
            }
          } catch (parseErr) {
            console.error('Error parsing SSE event:', parseErr);
          }
        }
      }
    }
  }

  // Paused at a gate: the human's decision continues the run, so there is
  // nothing to finalize yet.
  if (awaitingInput) return;

  callbacks.onFinalize(finalCode, finalExplanation, finalStl, currentProgressList, finalContract);
};
