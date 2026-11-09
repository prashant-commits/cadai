import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('theme tokens and glass utility', () => {
  const globalsCssPath = path.resolve(__dirname, 'globals.css');
  const content = fs.readFileSync(globalsCssPath, 'utf-8');

  it('globals.css defines the style A tokens', () => {
    const requiredTokens = [
      '--bg',
      '--bg-glow-1',
      '--bg-glow-2',
      '--bg-glow-3',
      '--glass-tint-top',
      '--glass-tint-bottom',
      '--glass-border',
      '--glass-border-top',
      '--glass-blur',
      '--radius-panel',
      '--accent-from',
      '--accent-to',
      '--fg',
      '--fg-muted',
    ];

    for (const token of requiredTokens) {
      const pattern = new RegExp(`(^|[\\s;{])${token}\\s*:`, 'm');
      expect(content, `Expected ${token} to be declared in globals.css`).toMatch(pattern);
    }
  });

  it('the glass utility uses the tokens', () => {
    const match = content.match(/@utility\s+glass\s*\{([^}]+)\}/);
    expect(match, 'Expected @utility glass { ... } to be present').not.toBeNull();
    const utilityBlock = match![1];
    expect(utilityBlock).toContain('backdrop-filter');
    expect(utilityBlock).toContain('var(--glass-blur)');
    expect(utilityBlock).toContain('var(--radius-panel)');
  });
});
