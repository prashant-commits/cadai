import { describe, expect, it } from 'vitest';
import { sanitizePythonBody } from '../agent/build-format';
import { checkPythonBody } from './body-check';

const opts = { reserved: ['width', 'depth'], components: ['base', 'lid', 'lid_part'] };
const ok = (body: string) => checkPythonBody(body, opts).ok;

describe('checkPythonBody rejects', () => {
  it.each([
    ['import', 'import os\nreturn Box(1, 1, 1)'],
    ['from-import', 'from os import path\nreturn Box(1, 1, 1)'],
    ['import after a # inside a string', 's = "#"; import os\nreturn Box(1, 1, 1)'],
    ['aliased open', 'f = open\nf("/tmp/x", "w")\nreturn Box(1, 1, 1)'],
    ['export_stl', 'p = Box(1, 1, 1)\nexport_stl(p, "/tmp/x.stl")\nreturn p'],
    ['export_step', 'export_step(Box(1, 1, 1), "/tmp/x.step")\nreturn Box(1, 1, 1)'],
    ['import_step', 'return import_step("/etc/passwd")'],
    ['Mesher', 'return Mesher().read("/tmp/x.3mf")'],
    ['exec', 'exec("x = 1")\nreturn Box(1, 1, 1)'],
    ['eval', 'return eval("Box(1, 1, 1)")'],
    ['compile', 'compile("1", "x", "eval")\nreturn Box(1, 1, 1)'],
    ['getattr', 'return getattr(Box, "x")'],
    ['dunder attribute', 'return Box(1, 1, 1).__class__'],
    ['dunder name', 'return __import__("os")'],
    ['dunder in a string', 'x = "__class__"\nreturn Box(1, 1, 1)'],
    ['f-string', 'x = f"{width}"\nreturn Box(1, 1, 1)'],
    ['str.format', 'x = "{0.x}".format(Box(1, 1, 1))\nreturn Box(1, 1, 1)'],
    ['fullwidth lookalike', 'ｅｘｅｃ("x")\nreturn Box(1, 1, 1)'],
    ['carriage return', 'x = 1\rimport os\nreturn Box(1, 1, 1)'],
    ['form feed', 'x = 1\f\nreturn Box(1, 1, 1)'],
    ['NUL', 'x = 1\u0000\nreturn Box(1, 1, 1)'],
    ['unterminated string', 'x = "abc\nreturn Box(1, 1, 1)'],
    ['column-0 def', 'def helper():\n    return 1\nreturn helper()'],
    ['indented def', 'if True:\n    def helper():\n        return Box(1, 1, 1)\nreturn helper()'],
    ['class', 'class A:\n    pass\nreturn Box(1, 1, 1)'],
    ['global', 'global width\nreturn Box(1, 1, 1)'],
    ['call of another component', 'return lid()'],
    ['alias of another component', 'f = lid\nreturn f()'],
    ['alias of itself', 'f = base\nreturn f()'],
    ['component passed as a value', 'return Box(lid, 1, 1)'],
    ['assignment to a parameter', 'width = 1\nreturn Box(width, 1, 1)'],
    ['indented assignment to a parameter', 'if True:\n    width = 1\nreturn Box(width, 1, 1)'],
    ['augmented assignment to a parameter', 'width += 1\nreturn Box(width, 1, 1)'],
    ['tuple assignment to a parameter', 'a, width = 1, 2\nreturn Box(width, 1, 1)'],
    ['for target is a parameter', 'for width in [1, 2]:\n    pass\nreturn Box(1, 1, 1)'],
    ['with target is a parameter', 'with BuildPart() as width:\n    Box(1, 1, 1)\nreturn width.part'],
    ['walrus onto a parameter', 'if (width := 3):\n    pass\nreturn Box(1, 1, 1)'],
    ['no return', 'p = Box(1, 1, 1)'],
  ])('%s', (_label, body) => {
    expect(ok(body)).toBe(false);
  });
});

describe('checkPythonBody accepts', () => {
  it.each([
    ['plain construction', 'part = Box(width, 1, 1)\nreturn part'],
    ['reading parameters', 'return Box(width, depth, 5)'],
    ['keyword arguments named like parameters', 'return Box(5, 5, 5, align=(Align.MIN, Align.MIN, Align.MIN), rotation=(0, 0, width))'],
    ['a local named like the part', 'base = Box(1, 1, 1)\nreturn base'],
    ['subscript assignment reading a parameter', 'd = {}\nd[width] = 1\nreturn Box(1, 1, 1)'],
    ['builder style', 'with BuildPart() as p:\n    Box(width, 1, 1)\nreturn p.part'],
    ['words in comments and strings', '# import os, exec(open("x"))\nlabel = "import os"\nreturn Box(1, 1, 1)'],
    ['math from the prelude', 'return Box(10 * sin(radians(30)), sqrt(4), pi)'],
    ['attribute that shares a banned spelling', 'return Box(1, 1, 1).open'],
    ['triple-quoted docstring', '"""notes\n# import os\n"""\nreturn Box(1, 1, 1)'],
  ])('%s', (_label, body) => {
    expect(checkPythonBody(body, opts)).toEqual({ ok: true });
  });
});

describe('sanitizePythonBody uses the token check', () => {
  it('dedents a uniformly indented body so a parameter write is seen and dropped', () => {
    expect(sanitizePythonBody('    width = 1\n    return Box(width, 1, 1)', ['base'], ['width'])).toBe('return Box(width, 1, 1)');
  });
  it('rejects an indented parameter write inside a block', () => {
    expect(sanitizePythonBody('if True:\n    width = 1\nreturn Box(1, 1, 1)', ['base'], ['width'])).toBeNull();
  });
  it('rejects a call to the emitted function name of a part', () => {
    expect(sanitizePythonBody('return lid_part()', ['lid'], [])).toBeNull();
  });
});
