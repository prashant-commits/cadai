/**
 * Prompt arms for the Architect ablation. Each arm appends text to the planner
 * and/or variant system prompt; a0 is the current product prompt unchanged.
 * Arms live in the eval until one wins: only the winner moves into
 * system-prompt.ts, so the product prompt never carries an untested block.
 */

const INSERTION = `HELD OBJECTS. Before any geometry, for each object the design holds, state in the sheet (and in the brief when planning): (1) the object and its rough size; (2) how it sits while stored, and which end points down; (3) the motion that puts it in and takes it out, as a world direction ("lowered straight down", "slid in from the front"); (4) what stops it falling (a lip, a ledge, friction, a hook). Every receiving feature's axis is parallel to that motion and its opening faces it. If the request names a feature ("ring", "cup", "slot", "hook"), say what that word implies about the insertion motion before choosing.`;

const USE_SEQUENCE = `HOW IT IS USED. Before any geometry, describe in the sheet (and in the brief when planning), step by step, how a person uses the object: where it is mounted or placed, how they put the held item in, how they take it out. Then name the most common commercial form of this product and say whether your design follows it; if it does not, give the reason from the request.`;

const DIVERGE = `DIFFERENT READINGS. When the request leaves the orientation, mounting or insertion direction open, variants A and B MUST take different readings of it, and each variant's idea must name its reading ("ring axis vertical, dryer dropped in from above" vs "ring axis horizontal, dryer slid in from the front"). Variant A takes the reading you judge most likely.`;

export const ARMS: Record<string, { planner: string; variant: string; about: string }> = {
  a0: { planner: '', variant: '', about: 'current prompt (in-use pose)' },
  a1: { planner: INSERTION, variant: INSERTION, about: 'held-object insertion block' },
  a2: { planner: USE_SEQUENCE, variant: USE_SEQUENCE, about: 'use sequence + common commercial form' },
  a4: { planner: `${INSERTION}\n\n${DIVERGE}`, variant: INSERTION, about: 'insertion block + planner variants must differ in reading' },
};

export function armSystemPrompt(base: string, arm: string, node: 'planner' | 'variant'): string {
  const block = ARMS[arm]?.[node];
  if (block === undefined) throw new Error(`unknown arm ${arm}: one of ${Object.keys(ARMS).join(', ')}`);
  return block ? `${base}\n\n${block}` : base;
}
