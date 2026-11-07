import { describe, it, expect } from 'vitest';
import { createSpecRenderer } from './spec-markdown';

describe('createSpecRenderer', () => {
  it('emits nothing for a key that is still the last one present', () => {
    const r = createSpecRenderer();
    expect(r.push({ assemblyName: 'brack' })).toBe('');
    expect(r.push({ assemblyName: 'bracket_body' })).toBe('');
  });

  it('emits a key once a later key proves it settled', () => {
    const r = createSpecRenderer();
    r.push({ assemblyName: 'bracket_body' });
    const out = r.push({ assemblyName: 'bracket_body', boundingBox: {} });
    expect(out).toContain('bracket_body');
  });

  it('never re-emits a key', () => {
    const r = createSpecRenderer();
    r.push({ assemblyName: 'bracket_body' });
    r.push({ assemblyName: 'bracket_body', boundingBox: {} });
    const again = r.push({ assemblyName: 'bracket_body', boundingBox: { width: 62 }, components: [] });
    expect(again).not.toContain('bracket_body');
  });

  it('renders a settled bounding box as dimensions', () => {
    const r = createSpecRenderer();
    r.push({ boundingBox: { width: 62, length: 40, height: 18 } });
    const out = r.push({ boundingBox: { width: 62, length: 40, height: 18 }, components: [] });
    expect(out).toContain('62 x 40 x 18 mm');
  });

  it('emits each component once the array grows past it', () => {
    const r = createSpecRenderer();
    r.push({ components: [{ name: 'body', description: 'main body' }] });
    const out = r.push({
      components: [
        { name: 'body', description: 'main body' },
        { name: 'arm', description: 'clamp arm' },
      ],
    });
    expect(out).toContain('body');
    expect(out).not.toContain('clamp arm');
  });

  it('LABELS an implausible dimension rather than dropping it', () => {
    const r = createSpecRenderer();
    r.push({ boundingBox: { width: 100101010101, length: 40, height: 18 } });
    const out = r.push({ boundingBox: { width: 100101010101, length: 40, height: 18 }, components: [] });
    expect(out).toContain('100101010101');
    expect(out).toContain('implausible');
  });

  it('flushes whatever is still pending when the stream ends', () => {
    const r = createSpecRenderer();
    r.push({ assemblyName: 'bracket_body' });
    expect(r.push({ assemblyName: 'bracket_body', __done: true })).toContain('bracket_body');
  });

  it('renders components with shape, extents, and position', () => {
    const r = createSpecRenderer();
    const out = r.push({
      components: [
        {
          name: 'box_plate',
          shape: { kind: 'box' },
          localExtents: [40, 30, 5],
          position: [0, 0, 0],
        },
      ],
      __done: true,
    });
    expect(out).toContain('- box_plate: box 40x30x5 mm @ [0, 0, 0]');
  });

  it('renders designLanguage when present', () => {
    const r = createSpecRenderer();
    r.push({
      assemblyName: 'phone_dock',
      designLanguage: {
        name: 'soft monolith',
        principles: ['one continuous body', 'soft 6 mm radius family on outer edges'],
        edgeRadius: 6,
        minorRadius: 1,
      },
    });
    const out = r.push({
      assemblyName: 'phone_dock',
      designLanguage: {
        name: 'soft monolith',
        principles: ['one continuous body', 'soft 6 mm radius family on outer edges'],
        edgeRadius: 6,
        minorRadius: 1,
      },
      boundingBox: { width: 100, length: 120, height: 80 },
    });
    expect(out).toContain('Design language: **soft monolith** (edge: 6 mm, minor: 1 mm)');
    expect(out).toContain('- one continuous body');
    expect(out).toContain('- soft 6 mm radius family on outer edges');
  });
});
