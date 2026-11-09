import { describe, it, expect } from 'vitest';
import {
  PRELUDES,
  PRELUDE_VERSION,
  PRELUDE_SENTINEL,
  hasPreludeSentinel,
  withGeneratedPrelude,
  toBody,
} from './prelude';
import { checkPythonScript } from './body-check';
import { DEFAULT_CODE } from '@/lib/storage/thread-storage';

describe('prelude', () => {
  it('exports PRELUDE_VERSION as 1 and defines PRELUDES[1]', () => {
    expect(PRELUDE_VERSION).toBe('1');
    expect(PRELUDES[PRELUDE_VERSION]).toBeDefined();
  });

  it('toBody keeps a header comment and drops the build123d import below it', () => {
    const script = '# Demo: a box\nfrom build123d import *\n\nwidth = 40  # [20:80] Width\nresult = Box(width, 1, 1)\n';
    expect(toBody(script)).toBe('# Demo: a box\n\nwidth = 40  # [20:80] Width\nresult = Box(width, 1, 1)\n');
    expect(checkPythonScript(withGeneratedPrelude(toBody(script), PRELUDE_VERSION)).ok).toBe(true);
  });

  it('a body that starts with a comment and code is unchanged', () => {
    const body = '# my bracket\n\nwidth = 10\nresult = Box(width, 1, 1)';
    expect(toBody(body)).toBe(body);
  });

  it('the default demo passes the script check as a body', () => {
    expect(checkPythonScript(withGeneratedPrelude(toBody(DEFAULT_CODE), PRELUDE_VERSION))).toEqual({ ok: true });
  });

  it('a copied prelude without a sentinel is stripped', () => {
    const bodyLines = 'width = 10\nresult = Box(width, 1, 1)';
    const full = `${PRELUDES['1']}\n\n${bodyLines}`;
    expect(toBody(full)).toBe(bodyLines);

    const withoutComments = PRELUDES['1']
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n');
    const fullWithoutComments = `${withoutComments}\n\n${bodyLines}`;
    expect(toBody(fullWithoutComments)).toBe(bodyLines);
  });

  it('a modified prelude is replaced', () => {
    const body = 'width = 10\nresult = Box(width, 1, 1)\n';
    const s = `import os\n${PRELUDES['1']}\n\n${PRELUDE_SENTINEL}\n\n${body}`;

    // checkPythonScript rejects the original script because of the modified prelude
    expect(checkPythonScript(s)).toMatchObject({
      ok: false,
      reason: 'prelude differs from the generated prelude',
    });

    const replaced = withGeneratedPrelude(toBody(s));
    expect(replaced.startsWith(PRELUDES['1'])).toBe(true);
    const sentinelMatches = replaced.match(new RegExp(PRELUDE_SENTINEL, 'g'));
    expect(sentinelMatches).toHaveLength(1);
    expect(replaced).not.toContain('import os');
    expect(checkPythonScript(replaced)).toEqual({ ok: true });
  });

  it('withGeneratedPrelude of an unknown version throws', () => {
    expect(() => withGeneratedPrelude('result = Box(1, 1, 1)', 'unknown')).toThrow(/unknown prelude version/i);
  });

  it('hasPreludeSentinel true/false cases', () => {
    expect(hasPreludeSentinel(`from build123d import *\n${PRELUDE_SENTINEL}\nresult = Box(1, 1, 1)`)).toBe(true);
    expect(hasPreludeSentinel('from build123d import *\nresult = Box(1, 1, 1)')).toBe(false);
  });

  it('toBody(withGeneratedPrelude(b)) === b for a body b', () => {
    const b = 'width = 10\nresult = Box(width, 1, 1)';
    expect(toBody(withGeneratedPrelude(b))).toBe(b);
  });

  it('toBody keeps a body that starts with try:', () => {
    const body = 'try:\n    x = 1\nexcept Exception:\n    x = 2\nresult = Box(x, 1, 1)';
    expect(toBody(body)).toBe(body);
  });

  it("toBody keeps the body's own leading comments", () => {
    const body = '# my bracket\nwidth = 10\nresult = Box(width, 1, 1)';
    expect(toBody(body)).toBe(body);
  });

  it('the exact copied 4-line _cadai_notes try block followed by a body is stripped to the body', () => {
    const body = 'width = 10\nresult = Box(width, 1, 1)';
    const script = `try:\n    _cadai_notes\nexcept NameError:\n    _cadai_notes = []\n${body}`;
    expect(toBody(script)).toBe(body);
  });

  it('does not strip lone lines from the _cadai_notes block', () => {
    const loneExcept = 'except NameError:\n    pass\nresult = Box(1, 1, 1)';
    expect(toBody(loneExcept)).toBe(loneExcept);

    const loneNotesVar = '_cadai_notes = []\nresult = Box(1, 1, 1)';
    expect(toBody(loneNotesVar)).toBe(loneNotesVar);
  });
});
