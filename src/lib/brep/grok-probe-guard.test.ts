import { describe, it, expect } from 'vitest';
import { checkPythonBody, checkPythonScript, PRELUDE_SENTINEL, GENERATED_PRELUDE } from './body-check';
import { applyParameterOverrides } from '../agent/designer/cost-params';

describe('Grok review probe-guard regressions', () => {
  it('rejects direct banned names and introspection in scripts', () => {
    expect(checkPythonScript("open('x')\n").ok).toBe(false);
    expect(checkPythonScript("export_stl(Box(1,1,1), 'x')\nresult = Box(1,1,1)\n").ok).toBe(false);
    expect(checkPythonScript('import os\nresult = Box(1,1,1)\n').ok).toBe(false);
    expect(checkPythonScript('g = (1 for _ in [1])\nb = g.gi_frame.f_builtins\nraise Exception("x")\n').ok).toBe(false);
  });

  it('rejects split import os and split body dunders', () => {
    expect(checkPythonScript('im\\\nport os\nresult = Box(1, 1, 1)\n').ok).toBe(false);
    const bodyPlainDunder = 'g = (1 for _ in [1])\nb = g.gi_frame.f_builtins\nreturn Box(1, 1, 1)\n';
    expect(checkPythonBody(bodyPlainDunder).ok).toBe(false);
  });

  it('rejects forged prelude and sentinel inside a string', () => {
    const forged = GENERATED_PRELUDE.replace('import math as _math', 'import os as _math') + '\n' + PRELUDE_SENTINEL + '\nresult = Box(1, 1, 1)\n';
    expect(checkPythonScript(forged).ok).toBe(false);

    const sentinelInString = 'x = "' + PRELUDE_SENTINEL + '"\nimport os\nresult = Box(1, 1, 1)\n';
    expect(checkPythonScript(sentinelInString).ok).toBe(false);
  });

  it('drops string parameter overrides and verifies numeric override', () => {
    const base = 'lid_open_deg = 0  # [0:5:120] angle\nresult = Box(1, 1, 1)\n';
    const injected = applyParameterOverrides(base, { lid_open_deg: '1\nimport os\n', width: 'os.system("id")' });
    expect(injected).toBe(base);

    const numbered = applyParameterOverrides(base, { lid_open_deg: 90 });
    expect(numbered).toContain('lid_open_deg = 90');
    expect(checkPythonScript(numbered).ok).toBe(true);
  });

  it('rejects positional font path in make_text and Text aliases (L1)', () => {
    const fontBody = 'return Compound.make_text("hi", 12, "Arial", "/etc/passwd")\n';
    expect(checkPythonBody(fontBody).ok).toBe(false);
    expect(checkPythonScript(fontBody + 'result = Box(1, 1, 1)\n').ok).toBe(false);

    const fontKw = 'result = Compound.make_text("hi", 12, font_path="/etc/passwd")\n';
    expect(checkPythonScript(fontKw).ok).toBe(false);

    const textAlias = 't = Text\nresult = t("hi", 12, "Arial", "/etc/passwd")\n';
    expect(checkPythonScript(textAlias).ok).toBe(false);

    const textDirect = 'result = Text("hi", 12, "Arial", "/etc/passwd")\n';
    expect(checkPythonScript(textDirect).ok).toBe(false);
  });
});
