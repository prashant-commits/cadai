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
    // Round 2 (H1): introspection without a dunder spelling.
    ['generator frame builtins (review probe)', "g = (1 for _ in [1])\nb = g.gi_frame.f_builtins\nb['exec']('import os')\nreturn Box(10, 10, 10)"],
    ['generator frame, string-built dunder key', "g = (1 for _ in [1])\nb = g.gi_frame.f_builtins\nb['_' * 2 + 'import' + '_' * 2]('os')\nreturn Box(1, 1, 1)"],
    ['frame globals via f_back', 'g = (1 for _ in [1])\nx = g.gi_frame.f_back.f_globals\nreturn Box(1, 1, 1)'],
    ['traceback frame via an exception', 'try:\n    1 / 0\nexcept ZeroDivisionError as e:\n    f = e.with_traceback(None)\n    t = f.tb_frame\nreturn Box(1, 1, 1)'],
    ['lambda globals', 'f = lambda: 0\ng = f.__globals__\nreturn Box(1, 1, 1)'],
    ['code object', 'f = lambda: 0\nc = f.co_code\nreturn Box(1, 1, 1)'],
    ['format string attribute walk', 'x = "{0.gi_frame}".format((1 for _ in [1]))\nreturn Box(1, 1, 1)'],
    ['private attribute deep in a chain', 'return Box(1, 1, 1).wrapped._x'],
    ['mro', 'return Box.mro()'],
    ['type()', 'return type(Box)(1, 1, 1)'],
    ['object', 'x = object\nreturn Box(1, 1, 1)'],
    ['super', 'x = super\nreturn Box(1, 1, 1)'],
    // Round 2 (M3): the script's own internals.
    ["a sibling's own-frame solid", 'return _l_a'],
    ["a sibling's placed solid", 'return _p_a.moved(Location())'],
    ['the fuse helper', 'return _fuse([])[0]'],
    // Round 2 (L1, L7).
    ['t-string', "x = t'{1}'\nreturn Box(1, 1, 1)"],
    ['raw t-string', "x = rt'{1}'\nreturn Box(1, 1, 1)"],
    ['font_path keyword', 'return extrude(Text("hi", 5, font_path="/etc/passwd"), amount=1)'],
    ['font keyword', 'return extrude(Text("hi", 5, font="/etc/passwd"), amount=1)'],
    ['any *_path keyword', 'return Box(1, 1, 1, label_path="/tmp/x")'],
    ['file keyword', 'return Box(1, 1, 1, filename="/tmp/x")'],
    ['Text with a font by position', 'return extrude(Text("hi", 5, "Arial", "/etc/passwd"), amount=1)'],
    // Round 3 (N1): a one-line compound header reads its condition, it does not bind it.
    ['if-header read of a sibling internal', 'if _l_a: z = 1\nreturn _l_a'],
    ['while-header read of a sibling internal', 'while _l_a: z = 1\nreturn _l_a'],
    ['for-iterable read of a sibling internal', 'for i in _l_a: z = 1\nreturn _l_a'],
    ['elif/else one-liners', 'if False: pass\nelif _p_a: z = 1\nelse: z = 2\nreturn _p_a'],
    ['with-header read of a sibling internal', 'with _l_a: z = 1\nreturn _l_a'],
    ['if-header read of a sibling component, then a call', 'if lid: z = 1\nreturn lid()'],
    // Round 3 (N4, N6).
    ['Text with * arguments', "return extrude(Text(*['a', 10, 'Arial', '/etc/hostname']), amount=1)"],
    ['Text with ** arguments', "return extrude(Text('a', **{'font_path': '/etc/hostname'}), amount=1)"],
    ['a font_path key in any dict', "opts = {'font_path': '/etc/hostname'}\nreturn Box(1, 1, 1)"],
    ['escaped underscores in a string', "x = '\\x5f\\x5fclass\\x5f\\x5f'\nreturn Box(1, 1, 1)"],
    ['octal-escaped underscore', "x = '\\137\\137'\nreturn Box(1, 1, 1)"],
    ['named-escape underscore', "x = '\\N{LOW LINE}'\nreturn Box(1, 1, 1)"],
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
    ['an underscore local the body defines', '_tmp = Box(1, 1, 1)\nreturn _tmp'],
    ['the throwaway name', 'for _ in range(2):\n    pass\nreturn Box(1, 1, 1)'],
    ['Text with size only', 'return extrude(Text("hi", 5), amount=1)'],
    ['a generator over sizes', 'return Box(max(x for x in [1, 2]), 1, 1)'],
    ['a for-header that binds an underscore local', 'for _i in range(2): z = _i\nreturn Box(1, 1, 1)'],
    ['a one-line if with a real binding', 'if width > 1: z = width\nelse: z = 1\nreturn Box(z, 1, 1)'],
    ['a one-line with-header binding', 'with BuildPart() as p: Box(1, 1, 1)\nreturn p.part'],
    ['a dict literal of sizes', "d = {'w': 1}\nreturn Box(d['w'], 1, 1)"],
    ['Text with keyword size', 'return extrude(Text("hi", font_size=5), amount=1)'],
  ])('%s', (_label, body) => {
    expect(checkPythonBody(body, opts)).toEqual({ ok: true });
  });
});

describe('sanitizePythonBody uses the token check', () => {
  it('keeps a column-0 keyword-argument line inside an open call (L4)', () => {
    expect(sanitizePythonBody('part = Box(\nwidth=5, length=3, height=2)\nreturn part', ['base'], ['width'])).toBe(
      'part = Box(\nwidth=5, length=3, height=2)\nreturn part',
    );
  });
  it('still drops a column-0 parameter write after the call closes (L4)', () => {
    expect(sanitizePythonBody('part = Box(\n1, 2, 3)\nwidth = 5\nreturn part', ['base'], ['width'])).toBe('part = Box(\n1, 2, 3)\nreturn part');
  });
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

describe('curated builtins and the guardrail stay in sync (N2)', () => {
  it('no builtin the runner provides is banned by the body check, and the common helpers are there', async () => {
    const { readFileSync } = await import('node:fs');
    const { BANNED_NAMES } = await import('./body-check');
    const run = readFileSync('geo/cadai_geo/run.py', 'utf-8');
    const block = /_SAFE_BUILTIN_NAMES = \(([\s\S]*?)\n\)/.exec(run)?.[1] ?? '';
    const names = [...block.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter((n) => BANNED_NAMES.has(n))).toEqual([]);
    for (const n of ['next', 'iter', 'hasattr', 'callable', 'chr', 'ord', 'bytes', 'StopIteration', 'slice', 'frozenset', 'hash']) {
      expect(names, n).toContain(n);
    }
    for (const n of ['open', 'exec', 'eval', 'getattr', 'type', 'object', 'id', 'vars', 'globals']) expect(names, n).not.toContain(n);
  });
});
