import type { ToolDef } from '../tool-registry';
import { Type } from 'lucide-react';
import { TextToolSettings, initialDraft, textApplyBlocker } from '../text-tool';

export const toolDef: ToolDef = {
  id: 'text',
  icon: Type,
  label: 'Text',
  needsFace: true,
  modifies: true,
  opKinds: ['text'],
  Settings: TextToolSettings,
  initialDraft,
  applyBlocker: textApplyBlocker,
};
