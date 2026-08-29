import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { build3mfXml } from './threemf-exporter';

describe('build3mfXml', () => {
  it('generates valid 3MF XML structure from Three.js BufferGeometry', () => {
    const geometry = new THREE.BoxGeometry(10, 20, 30);
    const xml = build3mfXml(geometry);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<model unit="millimeter"');
    expect(xml).toContain('<mesh>');
    expect(xml).toContain('<vertices>');
    expect(xml).toContain('<triangles>');
    expect(xml).toContain('</model>');
  });
});
