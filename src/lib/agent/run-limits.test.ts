import { describe, it, expect, afterEach, vi } from 'vitest';
import { graphRecursionLimit, describeGraphError } from './run-limits';

afterEach(() => {
  delete process.env.CADAI_SPEC_REVIEW_RETRIES;
  delete process.env.CADAI_MAX_ATTEMPTS;
});

describe('graphRecursionLimit', () => {
  it('is 3*(retries+1) + 2*attempts + 15, from the env vars the graph reads', () => {
    expect(graphRecursionLimit()).toBe(3 * 6 + 2 * 1 + 15);
    process.env.CADAI_SPEC_REVIEW_RETRIES = '8';
    process.env.CADAI_MAX_ATTEMPTS = '3';
    expect(graphRecursionLimit()).toBe(3 * 9 + 2 * 3 + 15);
  });

  it('falls back to the defaults on junk', () => {
    process.env.CADAI_SPEC_REVIEW_RETRIES = 'lots';
    expect(graphRecursionLimit()).toBe(3 * 1 + 2 * 1 + 15);
  });
});

describe('describeGraphError', () => {
  it('maps a recursion error to a short label, never the framework text', () => {
    const err = Object.assign(new Error('Recursion limit of 25 reached without hitting a stop condition. See troubleshooting'), {
      name: 'GraphRecursionError',
    });
    const msg = describeGraphError(err, 'Agent execution failed');
    expect(msg).toBe('Agent execution failed: the run took more steps than allowed and was stopped.');
    expect(msg).not.toContain('Recursion limit');
  });

  it('sends a short label for any other error and logs the raw text server-side', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const msg = describeGraphError(new Error('400 {"error":{"message":"giant provider payload"}}'), 'Agent execution failed');
      expect(msg).toBe('Agent execution failed; see server logs.');
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.flat().map(String).join(' ')).toContain('giant provider payload');
    } finally {
      spy.mockRestore();
    }
  });
});
