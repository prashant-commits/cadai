import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

function walk(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') {
        results.push(...walk(fullPath, ext));
      }
    } else if (entry.isFile() && fullPath.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('no emoji in UI source', () => {
  it('no emoji in UI source', () => {
    const root = path.resolve(__dirname, '../..');
    const files = [
      ...walk(path.join(root, 'src/components'), '.tsx'),
      ...walk(path.join(root, 'src/app'), '.tsx'),
      ...walk(path.join(root, 'src/lib/storage'), '.ts'),
    ];

    const emojiRegex = /\p{Extended_Pictographic}/u;
    const failures: string[] = [];

    for (const absPath of files) {
      if (absPath.includes('node_modules')) continue;
      const relPath = path.relative(root, absPath);
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (emojiRegex.test(line)) {
          failures.push(`${relPath}:${i + 1}`);
        }
      }
    }

    expect(
      failures,
      `Found emoji in UI source files:\n${failures.join('\n')}`
    ).toEqual([]);
  });
});
