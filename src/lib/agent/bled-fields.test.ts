import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/bled-tool-inputs.json';
import { normalizeClaudeSentinels, recoverBledFields } from './llm-schemas';
import { AssemblySpecSchema } from './assembly-spec';
import { nullsToUndefined } from './strict-schema';

describe('recoverBledFields', () => {
  it('recovers every Haiku 5.5 spec whose parameters string swallowed the later fields (P0b batch)', () => {
    const entries = Object.entries(fixtures as Record<string, Record<string, unknown>>);
    expect(entries.length).toBe(6);
    for (const [id, input] of entries) {
      const parsed = AssemblySpecSchema.safeParse(nullsToUndefined(normalizeClaudeSentinels(input)));
      if (id === 'bike_hook_wall-s1-A') {
        // Recovered, but this spec has its own unrelated error (a hole `at` with two coordinates).
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues.every((i) => i.path[0] === 'components' && i.path.includes('holes'))).toBe(true);
        continue;
      }
      expect(parsed.success, `${id}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues[0])}`).toBe(true);
      if (parsed.success) expect(parsed.data.components?.length ?? 0, id).toBeGreaterThan(0);
    }
  });

  it('never overwrites a field the model sent properly', () => {
    const out = recoverBledFields({ parameters: '[{"name":"w"}], "components": [{"name":"bled"}]', components: [{ name: 'real' }] });
    expect(out.parameters).toEqual([{ name: 'w' }]);
    expect(out.components).toEqual([{ name: 'real' }]);
  });

  it('reads the markup form and the extra closing brace', () => {
    expect(recoverBledFields({ parameters: '[1]</parameters>\n<parameter name="derived">[2]' })).toMatchObject({ parameters: [1], derived: [2] });
    expect(recoverBledFields({ parameters: '[1], "relations": [3]}' })).toMatchObject({ parameters: [1], relations: [3] });
  });

  it('fills an empty placeholder the model left for a swallowed field, and reads a double closing brace', () => {
    expect(recoverBledFields({ parameters: '[1], "components": [{"name":"c"}]', components: [] })).toMatchObject({ components: [{ name: 'c' }] });
    expect(recoverBledFields({ parameters: '[1], "box": {"w": 2}}}' })).toMatchObject({ parameters: [1], box: { w: 2 } });
  });

  it('leaves a string that is not a bled array alone', () => {
    expect(recoverBledFields({ parameters: 'none' })).toEqual({ parameters: 'none' });
    expect(recoverBledFields({ parameters: [1] })).toEqual({ parameters: [1] });
  });
});
