import { describe, it, expect } from 'vitest';
import {
  RUN_ACTIVE,
  LEGACY,
  REFUSAL,
  FAILED_CHECKS,
  COMPILE_FAILED,
  STOPPED,
  NO_CHANGE,
  RUN_LOST,
  DEADLINE,
  BUILD_FAILED,
  SAVE_FAILED,
  STALE_CLIENT,
  BAD_ATTACHMENT,
  BAD_EDIT,
  BAD_PIN,
  NEEDS_PROJECT,
  WRONG_PROJECT,
  DEFAULT_PROJECT_NAME,
  BAD_PROJECT_NAME,
  TERMINATE_REPLY,
  userEditSummary,
} from './phrases';

describe('phrases', () => {
  it("every phrase equals the plan's exact text", () => {
    expect(RUN_ACTIVE).toBe('A design is still being built in this thread.');
    expect(LEGACY).toBe(
      'This conversation was saved before server history. Start a new conversation to keep editing.'
    );
    expect(REFUSAL).toBe("I can't help with that request.");
    expect(FAILED_CHECKS).toBe('Built, but it failed checks:');
    expect(COMPILE_FAILED).toBe('The script did not compile.');
    expect(STOPPED).toBe('Stopped.');
    expect(NO_CHANGE).toBe('No changes were needed.');
    expect(RUN_LOST).toBe('The build stopped unexpectedly. Please send your message again.');
    expect(DEADLINE).toBe('The build ran out of time. Try a simpler request or send it again.');
    expect(BUILD_FAILED).toBe('The build failed. Please send your message again.');
    expect(SAVE_FAILED).toBe(
      'Something went wrong while saving this design. Reload to see the latest state.'
    );
    expect(STALE_CLIENT).toBe('Reload the page and try again.');
    expect(BAD_ATTACHMENT).toBe(
      'Only PNG, JPEG or WebP images up to 5 MB, at most 4 per message.'
    );
    expect(BAD_EDIT).toBe(
      "The edited code uses something that isn't allowed, so it wasn't saved."
    );
    expect(BAD_PIN).toBe("A slider value isn't a valid number, so it wasn't applied.");
    expect(NEEDS_PROJECT).toBe('A new thread needs a project.');
    expect(WRONG_PROJECT).toBe(
      'This thread belongs to another project. Reload the page and try again.'
    );
    expect(DEFAULT_PROJECT_NAME).toBe('My designs');
    expect(BAD_PROJECT_NAME).toBe('A project name needs 1 to 120 characters.');
  });

  it('TERMINATE_REPLY maps all five codes', () => {
    expect(TERMINATE_REPLY.cancelled).toEqual({ kind: 'cancelled', markdown: STOPPED });
    expect(TERMINATE_REPLY.run_lost).toEqual({ kind: 'error', markdown: RUN_LOST });
    expect(TERMINATE_REPLY.deadline).toEqual({ kind: 'error', markdown: DEADLINE });
    expect(TERMINATE_REPLY.graph).toEqual({ kind: 'error', markdown: BUILD_FAILED });
    expect(TERMINATE_REPLY.internal).toEqual({ kind: 'error', markdown: SAVE_FAILED });
  });

  it('userEditSummary three cases', () => {
    expect(userEditSummary(false, true)).toBe('Your edit (sliders)');
    expect(userEditSummary(true, false)).toBe('Your edit (code)');
    expect(userEditSummary(true, true)).toBe('Your edit (code and sliders)');
  });
});
