import { describe, expect, it } from 'vitest';
import { BUILDER_MODE_REASON, checkPythonBody, checkPythonScript, isBuilderModeReason, GENERATED_PRELUDE, PRELUDE_SENTINEL } from './body-check';
import { PRELUDES, withGeneratedPrelude } from './prelude';
import { FONT_IDS } from '../tools/op-text';

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
    ['algebra style', 'p = Pos(0, 0, 1) * Box(width, 1, 1)\nreturn p'],
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
    ['a one-line with-header binding', 'with Locations((0, 0, 0)) as p: q = Box(1, 1, 1)\nreturn q'],
    ['a dict literal of sizes', "d = {'w': 1}\nreturn Box(d['w'], 1, 1)"],
    ['Text with keyword size', 'return extrude(Text("hi", font_size=5), amount=1)'],
  ])('%s', (_label, body) => {
    expect(checkPythonBody(body, opts)).toEqual({ ok: true });
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

describe('builder mode is rejected with a reason that names the fix', () => {
  const profile = 'with BuildSketch(Plane.YZ):\n    with BuildLine():\n        Polyline((0, 0), (20, 0), (0, 20), close=True)\n    make_face()\nextrude(amount=80)\nreturn Box(1, 1, 1)';

  it.each([
    ['with BuildPart', 'with BuildPart() as p:\n    Box(10, 10, 10)\nreturn p.part'],
    ['with BuildSketch', 'with BuildSketch(Plane.XY):\n    Circle(3)\nreturn Box(1, 1, 1)'],
    ['with BuildLine', 'with BuildLine():\n    Line((0, 0), (1, 1))\nreturn Box(1, 1, 1)'],
    ['the phone_stand body from the matrix', profile],
    ['a builder bound to a name', 'p = BuildPart()\nreturn Box(1, 1, 1)'],
  ])('%s', (_label, body) => {
    const verdict = checkPythonBody(body, opts);
    expect(verdict).toEqual({ ok: false, reason: BUILDER_MODE_REASON });
    expect(isBuilderModeReason(`body rejected (${BUILDER_MODE_REASON}); drawn from the blockout`)).toBe(true);
  });

  it('the reason spells out both algebra forms', () => {
    expect(BUILDER_MODE_REASON).toContain('extrude(Plane.YZ * Polygon(*pts, align=None), amount=w)');
    expect(BUILDER_MODE_REASON).toContain('extrude(make_face(Polyline(*pts, close=True)), amount=w)');
  });

  it('accepts the algebra forms it recommends', () => {
    expect(ok('pts = [(0, 0), (20, 0), (0, 20)]\nreturn extrude(Plane.YZ * Polygon(*pts, align=None), amount=80)')).toBe(true);
    expect(ok('pts = [(0, 0), (20, 0), (0, 20)]\nreturn extrude(make_face(Polyline(*pts, close=True)), amount=80)')).toBe(true);
  });

  it('accepts fillet, chamfer, _round, _bevel and _select_edges', () => {
    expect(ok('b = Box(20, 20, 10)\nreturn fillet(b.edges().filter_by(Axis.Z), 2)')).toBe(true);
    expect(ok('b = Box(20, 20, 10)\nreturn chamfer(b.edges().filter_by(Axis.Z), 1)')).toBe(true);
    expect(ok('b = Box(20, 20, 10)\nreturn _round(b, 2, "outer")')).toBe(true);
    expect(ok('b = Box(20, 20, 10)\nreturn _bevel(b, 1, "vertical")')).toBe(true);
    expect(ok('b = Box(20, 20, 10)\nedges = _select_edges(b, "top")\nreturn fillet(edges, 1)')).toBe(true);
  });

  it('still rejects unauthorized _-prefixed names', () => {
    expect(checkPythonBody('return _fuse([])', opts)).toMatchObject({ ok: false, reason: 'refers to _fuse, which the body does not define' });
    expect(checkPythonBody('return _unknown(Box(1, 1, 1))', opts)).toMatchObject({ ok: false });
  });

  it('does not mistake an unrelated name or an attribute for a builder', () => {
    expect(ok('BuildPartCount = 3\nreturn Box(BuildPartCount, 1, 1)')).toBe(true);
    expect(ok('return Box(1, 1, 1).BuildPart')).toBe(true);
  });

  it('is a rejection of an unrelated body that keeps its own reason', () => {
    expect(checkPythonBody('import os\nreturn Box(1, 1, 1)', opts)).toMatchObject({ ok: false });
    expect(isBuilderModeReason('import is not allowed in a body')).toBe(false);
  });
});

describe('checkPythonScript', () => {
  const valid = `${GENERATED_PRELUDE}\n${PRELUDE_SENTINEL}\nb = Box(10, 10, 10)\nresult = b\n`;

  it('accepts valid script matching generated prelude', () => {
    expect(checkPythonScript(valid)).toEqual({ ok: true });
  });

  it('rejects frame-escape probe and import os after the sentinel', () => {
    const withImport = valid + '\nimport os\n';
    expect(checkPythonScript(withImport)).toEqual({
      ok: false,
      reason: 'import is not allowed in a script',
    });

    const probe = valid + '\ng = (1 for _ in [1])\nb = g.gi_frame.f_builtins\n';
    expect(checkPythonScript(probe)).toEqual({
      ok: false,
      reason: 'attribute .gi_frame is not allowed in a script',
    });
  });

  it('rejects a prelude that differs from the generated one', () => {
    const modifiedPrelude = valid.replace('from build123d import *', 'from build123d import *\nimport os');
    expect(checkPythonScript(modifiedPrelude)).toEqual({
      ok: false,
      reason: 'prelude differs from the generated prelude',
    });
  });

  it('accepts a script built with an older registry entry', () => {
    const oldPrelude = 'from build123d import *\nimport math as _math\ndef _old(): pass';
    PRELUDES['0'] = oldPrelude;
    try {
      const body = 'width = 10\nresult = Box(width, 10, 10)\n';
      const script = withGeneratedPrelude(body, '0');
      expect(checkPythonScript(script)).toEqual({ ok: true });

      const unmatched = script.replace('from build123d import *', 'from build123d import *\nimport os');
      expect(checkPythonScript(unmatched)).toEqual({
        ok: false,
        reason: 'prelude differs from the generated prelude',
      });
    } finally {
      delete PRELUDES['0'];
    }
  });
});

describe('CADAI_FONTS and font_path whitelist', () => {
  it.each(FONT_IDS)('accepts valid font_path with CADAI_FONTS for %s in body and script', (fontId) => {
    const body = `return extrude(Text("hi", 5, font_path=CADAI_FONTS + "/${fontId}.ttf"), amount=1)`;
    expect(checkPythonBody(body, opts)).toEqual({ ok: true });

    const script = `${GENERATED_PRELUDE}\n${PRELUDE_SENTINEL}\nb = extrude(Text("hi", 5, font_path=CADAI_FONTS + "/${fontId}.ttf"), amount=1)\nresult = b\n`;
    expect(checkPythonScript(script)).toEqual({ ok: true });
  });

  it('accepts valid font_path followed by another argument or closing paren', () => {
    const bodyWithComma = `return extrude(Text("hi", 5, font_path=CADAI_FONTS + "/inter-bold.ttf", text_align=(TextAlign.CENTER, TextAlign.CENTER)), amount=1)`;
    expect(checkPythonBody(bodyWithComma, opts)).toEqual({ ok: true });
  });

  it.each([
    ['another string font_path', 'return extrude(Text("hi", 5, font_path="/etc/passwd"), amount=1)'],
    ['another ttf string', 'return extrude(Text("hi", 5, font_path="/other.ttf"), amount=1)'],
    ['name passed to font_path', 'return extrude(Text("hi", 5, font_path=my_font), amount=1)'],
    ['CADAI_FONTS + variable', 'return extrude(Text("hi", 5, font_path=CADAI_FONTS + x), amount=1)'],
    ['path traversal with CADAI_FONTS', 'return extrude(Text("hi", 5, font_path=CADAI_FONTS + "/../inter-bold.ttf"), amount=1)'],
    ['bytes-prefixed font string', 'return extrude(Text("hi", 5, font_path=CADAI_FONTS + b"/inter-bold.ttf"), amount=1)'],
    ['f-string font_path', 'return extrude(Text("hi", 5, font_path=CADAI_FONTS + f"/inter-bold.ttf"), amount=1)'],
    ['dict unpack font_path', 'return extrude(Text("hi", 5, **{"font_path": CADAI_FONTS + "/inter-bold.ttf"}), amount=1)'],
    ['bare CADAI_FONTS', 'x = CADAI_FONTS\nreturn Box(1, 1, 1)'],
    ['assigned CADAI_FONTS', 'CADAI_FONTS = "/path"\nreturn Box(1, 1, 1)'],
    ['rebound by for', 'for CADAI_FONTS in [1, 2]: pass\nreturn Box(1, 1, 1)'],
    ['rebound by with', 'with Box(1, 1, 1) as CADAI_FONTS: pass\nreturn Box(1, 1, 1)'],
    ['rebound by walrus', 'if (CADAI_FONTS := 1): pass\nreturn Box(1, 1, 1)'],
    ['augmented assignment to CADAI_FONTS', 'CADAI_FONTS += 1\nreturn Box(1, 1, 1)'],
    ['passed elsewhere', 'return Box(CADAI_FONTS, 1, 1)'],
    ['used as font=', 'return extrude(Text("hi", 5, font=CADAI_FONTS), amount=1)'],
    ['other file keyword filename', 'return Box(1, 1, 1, filename="/tmp/x")'],
    ['other file keyword filepath', 'return Box(1, 1, 1, filepath="/tmp/x")'],
  ])('rejects %s in body and script', (_label, body) => {
    expect(checkPythonBody(body, opts).ok).toBe(false);

    const script = `${GENERATED_PRELUDE}\n${PRELUDE_SENTINEL}\n${body.replace(/return /g, 'result = ')}\n`;
    expect(checkPythonScript(script).ok).toBe(false);
  });
});

