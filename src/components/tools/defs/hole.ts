import type { ToolDef } from '../tool-registry';
import { CircleDashed } from 'lucide-react';
import { HoleSettings, initialDraft } from '../hole-tool';

export const toolDef: ToolDef = {
  id: 'hole',
  icon: CircleDashed,
  label: 'Hole',
  needsFace: true,
  modifies: true,
  opKinds: ['hole', 'cut-rect'],
  Settings: HoleSettings,
  initialDraft,
};
