import type { GatePayload } from '@/types';
import type { StreamEvent } from './stream-events';

/** Human labels for graph nodes. An unlisted node falls back to its own id. */
export const NODE_LABELS: Record<string, string> = {
  architectNode: 'Mechanical Architect',
  specGate: 'Spec Review',
  drafterNode: 'Parametric Drafter',
  validateCode: 'Physical Validator',
  fixCode: 'Repair',
  visualCritic: 'Design Inspector',
  acceptGate: 'Model Review',
  respondToUser: 'Result',
};

type CustomPayload = StreamEvent & { node?: string };

/**
 * Translates langgraph's [mode, payload] tuples into the client's event union.
 *
 * Shapes verified by spike against langgraph 1.4.12: `custom` yields the bare
 * payload, `messages` yields [chunk, metadata] with metadata.langgraph_node,
 * and an interrupt arrives as ['updates', { __interrupt__: [{ id, value }] }].
 */
export async function bridgeGraphStream(
  chunks: AsyncIterable<unknown>,
  runId: string,
  emit: (event: StreamEvent) => void
): Promise<void> {
  let openNode: string | null = null;

  function closeOpen() {
    if (openNode === null) return;
    emit({ t: 'section', id: openNode, state: 'close', status: 'ok' });
    openNode = null;
  }

  function openFor(node: string) {
    if (openNode === node) return;
    closeOpen();
    emit({ t: 'section', id: node, label: NODE_LABELS[node] ?? node, state: 'open' });
    openNode = node;
  }

  for await (const chunk of chunks) {
    if (!Array.isArray(chunk) || chunk.length < 2) continue;
    const [mode, payload] = chunk as [string, unknown];

    if (mode === 'custom') {
      const p = payload as CustomPayload;
      if (p.t === 'delta') {
        openFor(p.node ?? 'agent');
        emit({ t: 'delta', text: p.text });
      } else if (p.t === 'result') {
        closeOpen();
        const { node: _node, ...rest } = p;
        emit(rest as StreamEvent);
      } else if (p.t === 'error') {
        closeOpen();
        emit({ t: 'error', message: p.message });
      }
      continue;
    }

    if (mode === 'messages') {
      const [msg, meta] = payload as [{ content?: unknown }, { langgraph_node?: string }];
      const text = typeof msg?.content === 'string' ? msg.content : '';
      if (!text) continue;
      openFor(meta?.langgraph_node ?? 'agent');
      emit({ t: 'delta', text });
      continue;
    }

    if (mode === 'updates') {
      const upd = payload as Record<string, unknown>;
      const interrupts = upd.__interrupt__ as Array<{ id: string; value: unknown }> | undefined;
      if (!interrupts?.length) continue;
      closeOpen();
      for (const i of interrupts) {
        emit({ t: 'gate', id: i.id, runId, payload: i.value as GatePayload });
      }
    }
  }

  closeOpen();
}
