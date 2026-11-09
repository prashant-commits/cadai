import { describe, it, expect } from 'vitest';
import { STARTER_IDEAS, pickTwo } from './starter-ideas';

describe('starter ideas', () => {
  it('pickTwo returns two different ideas from STARTER_IDEAS', () => {
    // Test constant generators: () => 0, () => 0.9999, () => 0.5
    const constantFns = [
      () => 0,
      () => 0.9999,
      () => 0.5,
    ];

    for (const rand of constantFns) {
      const [first, second] = pickTwo(rand);
      expect(STARTER_IDEAS).toContain(first);
      expect(STARTER_IDEAS).toContain(second);
      expect(first).not.toBe(second);
    }

    // Seeded LCG over 200 draws
    let seed = 12345;
    const lcg = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    for (let draw = 0; draw < 200; draw++) {
      const [first, second] = pickTwo(lcg);
      expect(STARTER_IDEAS).toContain(first);
      expect(STARTER_IDEAS).toContain(second);
      expect(first).not.toBe(second);
    }
  });

  it('STARTER_IDEAS has at least 10 entries and no emoji', () => {
    // Length at least 10 (and brief asks for at least 12)
    expect(STARTER_IDEAS.length).toBeGreaterThanOrEqual(10);

    // Contains the five verbatim strings
    const verbatim = [
      'NEMA 17 motor mount with belt tensioner',
      'Raspberry Pi 5 enclosure with fan and port cutouts',
      '608 bearing pillow block, M5 bolts',
      '2020 extrusion corner bracket',
      'Hinged electronics box with cable gland',
    ];
    for (const s of verbatim) {
      expect(STARTER_IDEAS).toContain(s);
    }

    // No entry matches emoji
    const emojiRegex = /\p{Extended_Pictographic}/u;
    for (const entry of STARTER_IDEAS) {
      expect(emojiRegex.test(entry)).toBe(false);
    }

    // Entries are unique
    const unique = new Set(STARTER_IDEAS);
    expect(unique.size).toBe(STARTER_IDEAS.length);
  });
});
