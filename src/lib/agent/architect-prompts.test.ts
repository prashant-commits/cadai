import { describe, expect, it } from 'vitest';
import { requiredChanges, variantNamedIn } from './architect-prompts';

describe('requiredChanges', () => {
  it('lists majors, then minors, then the human lines', () => {
    const text = requiredChanges(
      [{ severity: 'minor', issue: 'plate looks thin' }, { severity: 'major', issue: 'ring is sideways' }],
      ['Add a front lip'],
    );
    expect(text.indexOf('[MAJOR] ring is sideways')).toBeLessThan(text.indexOf('[MINOR] plate looks thin'));
    expect(text.indexOf('[MINOR] plate looks thin')).toBeLessThan(text.indexOf('[HUMAN] Add a front lip'));
  });

  it('makes every human line mandatory for this variant, even when it names another variant', () => {
    // A live revise answered "Front lip (variant B)" while variant A was revised, and Haiku
    // wrote "NOT applied in variant A": human lines read as optional next to the majors rule.
    const text = requiredChanges([], ['Should it have a front lip?: Front lip (variant B)']);
    expect(text).toMatch(/Every \[HUMAN\] line is the user's instruction for THIS variant/);
    expect(text).toMatch(/even when it names another variant/);
    expect(text).toMatch(/OUTRANK[\s\S]*variant A follows the request literally/);
  });

  it('says so when nothing is listed', () => {
    expect(requiredChanges([], [])).toContain('(none listed)');
  });
});

describe('variantNamedIn', () => {
  it('finds the one variant the user named', () => {
    expect(variantNamedIn(['Front lip (variant B), thick enough for daily use'], ['A', 'B', 'C'])).toBe('B');
    expect(variantNamedIn(['go with Variant C please'], ['A', 'B', 'C'])).toBe('C');
  });

  it('returns null when none or several are named, or the named one does not exist', () => {
    expect(variantNamedIn(['make it taller'], ['A', 'B'])).toBeNull();
    expect(variantNamedIn(['variant A or variant B'], ['A', 'B'])).toBeNull();
    expect(variantNamedIn(['variant C'], ['A', 'B'])).toBeNull();
  });
});
