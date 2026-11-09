import type { StreamEvent } from './stream-events';
import type { TranscriptNode, TranscriptSection } from './transcript';
import { escapeMarkers } from './transcript';
import type { RunStatus } from '../persist/types';

export class TranscriptBuilder {
  readonly nodes: TranscriptNode[] = [];
  private open: TranscriptSection | null = null;

  private ensureOpen(): TranscriptSection {
    if (this.open) return this.open;
    this.open = { kind: 'section', id: 'agent', label: 'Agent', status: 'running', body: '' };
    this.nodes.push(this.open);
    return this.open;
  }

  apply(event: StreamEvent): void {
    switch (event.t) {
      case 'section':
        if (event.state === 'open') {
          this.open = { kind: 'section', id: event.id, label: event.label, status: 'running', body: '' };
          this.nodes.push(this.open);
        } else if (this.open) {
          this.open.status = event.status;
          if (event.summary) {
            this.open.body += `\n\n${escapeMarkers(event.summary)}`;
          }
          this.open = null;
        }
        return;
      case 'delta':
        this.ensureOpen().body += escapeMarkers(event.text);
        return;
      case 'end':
        this.closeOpen(event.status);
        return;
    }
  }

  closeOpen(status?: RunStatus): void {
    if (this.open) {
      this.open.status = status === 'failed' ? 'error' : 'ok';
      this.open = null;
    }
  }
}

export function buildTranscript(events: StreamEvent[], endStatus?: RunStatus): TranscriptNode[] {
  const builder = new TranscriptBuilder();
  for (const ev of events) {
    builder.apply(ev);
  }
  if (endStatus) {
    builder.closeOpen(endStatus);
  }
  return builder.nodes;
}
