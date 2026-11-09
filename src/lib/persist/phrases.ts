export const RUN_ACTIVE = 'A design is still being built in this thread.';
export const LEGACY =
  'This conversation was saved before server history. Start a new conversation to keep editing.';
export const REFUSAL = "I can't help with that request.";
export const FAILED_CHECKS = 'Built, but it failed checks:';
export const COMPILE_FAILED = 'The script did not compile.';
export const STOPPED = 'Stopped.';
export const NO_CHANGE = 'No changes were needed.';
export const RUN_LOST = 'The build stopped unexpectedly. Please send your message again.';
export const DEADLINE = 'The build ran out of time. Try a simpler request or send it again.';
export const BUILD_FAILED = 'The build failed. Please send your message again.';
export const SAVE_FAILED =
  'Something went wrong while saving this design. Reload to see the latest state.';
export const STALE_CLIENT = 'Reload the page and try again.';
export const BAD_ATTACHMENT =
  'Only PNG, JPEG or WebP images up to 5 MB, at most 4 per message.';
export const BAD_EDIT =
  "The edited code uses something that isn't allowed, so it wasn't saved.";
export const BAD_PIN = "A slider value isn't a valid number, so it wasn't applied.";
export const BUSY = 'The server is busy. Try again in a minute.';
export const BUDGET_USED = "Today's build budget is used up.";
export const NEEDS_PROJECT = 'A new thread needs a project.';
export const WRONG_PROJECT =
  'This thread belongs to another project. Reload the page and try again.';
export const DEFAULT_PROJECT_NAME = 'My designs';
export const BAD_PROJECT_NAME = 'A project name needs 1 to 120 characters.';
export const WELCOME = 'Describe a part to start, or attach a sketch.';

export type TerminateCode = 'cancelled' | 'run_lost' | 'deadline' | 'graph' | 'internal';

export const TERMINATE_REPLY: Record<
  TerminateCode,
  { kind: 'cancelled' | 'error'; markdown: string }
> = {
  cancelled: { kind: 'cancelled', markdown: STOPPED },
  run_lost: { kind: 'error', markdown: RUN_LOST },
  deadline: { kind: 'error', markdown: DEADLINE },
  graph: { kind: 'error', markdown: BUILD_FAILED },
  internal: { kind: 'error', markdown: SAVE_FAILED },
};

export function userEditSummary(code: boolean, sliders: boolean): string {
  if (code && sliders) return 'Your edit (code and sliders)';
  if (code) return 'Your edit (code)';
  if (sliders) return 'Your edit (sliders)';
  return 'Your edit';
}

export function unchangedNote(v: number | null | undefined): string {
  return `The design is unchanged (still v${v}).`;
}
