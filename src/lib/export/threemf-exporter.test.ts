import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { build3mfXml, partsFromTopology } from './threemf-exporter';
import type { ToolOp } from '@/lib/tools/ops';
import type { Topology } from '@/lib/geometry/topology';

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

  it('the 3MF export writes the material color for its part', () => {
    const geometry = new THREE.BoxGeometry(10, 20, 30);

    const parts = [
      {
        name: 'lid',
        positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0]),
        indices: new Uint32Array([0, 1, 2]),
      },
      {
        name: 'base',
        positions: new Float32Array([0, 0, 0, 20, 0, 0, 20, 20, 0]),
        indices: new Uint32Array([0, 1, 2]),
      },
    ];

    const materials: Array<Extract<ToolOp, { kind: 'material' }>> = [
      {
        kind: 'material',
        id: 'mat_lid',
        target: 'lid',
        material: 'brushed-metal',
        color: '#a0a4ab',
      },
    ];

    const xml = build3mfXml(geometry, { parts, materials });

    expect(xml).toContain('<basematerials');
    expect(xml).toContain('<base name="Brushed metal" displaycolor="#A0A4ABFF"');

    // lid object carries pid and pindex
    const lidMatch = xml.match(/<object[^>]+name="lid"[^>]*>/);
    expect(lidMatch).not.toBeNull();
    expect(lidMatch![0]).toContain('pid="1"');
    expect(lidMatch![0]).toContain('pindex="0"');

    // base object does not carry pid or pindex
    const baseMatch = xml.match(/<object[^>]+name="base"[^>]*>/);
    expect(baseMatch).not.toBeNull();
    expect(baseMatch![0]).not.toContain('pid=');
    expect(baseMatch![0]).not.toContain('pindex=');
  });

  it('partsFromTopology splits the mesh by part label', () => {
    // 2 triangles: tri 0 on lid (face 1), tri 1 on base (face 2)
    const positions = new Float32Array([
      0, 0, 0,
      10, 0, 0,
      10, 10, 0,
      20, 20, 0,
      30, 20, 0,
      30, 30, 0,
    ]);
    const indices = new Uint32Array([
      0, 1, 2,
      3, 4, 5,
    ]);
    const faceIds = new Uint32Array([
      1,
      2,
    ]);

    const topo: Topology = {
      mesh: { positions, indices, faceIds },
      faces: [
        { id: 1, part: 'lid', kind: 'plane', area: 50, center: [6.6, 3.3, 0] },
        { id: 2, part: 'base', kind: 'plane', area: 50, center: [26.6, 23.3, 0] },
      ],
      edges: [],
      parts: [
        { label: 'lid', min: [0, 0, 0], max: [10, 10, 0] },
        { label: 'base', min: [20, 20, 0], max: [30, 30, 0] },
      ],
    };

    const parts = partsFromTopology(topo);
    expect(parts).toHaveLength(2);

    const lidPart = parts.find((p) => p.name === 'lid');
    const basePart = parts.find((p) => p.name === 'base');

    expect(lidPart).toBeDefined();
    expect(basePart).toBeDefined();

    expect(lidPart!.positions.length).toBe(9);
    expect(lidPart!.indices.length).toBe(3);

    expect(basePart!.positions.length).toBe(9);
    expect(basePart!.indices.length).toBe(3);
  });

  it('the fused 3MF carries the model material when there are no part meshes', () => {
    const geometry = new THREE.BoxGeometry(10, 20, 30);
    const materials: Array<Extract<ToolOp, { kind: 'material' }>> = [
      {
        kind: 'material',
        id: 'mat_model',
        target: 'model',
        material: 'wood',
        color: '#a0703c',
      },
    ];

    const xml = build3mfXml(geometry, { materials });
    expect(xml).toContain('<basematerials id="1">');
    expect(xml).toContain('<base name="Wood" displaycolor="#A0703CFF" />');
    expect(xml).toContain('<object id="1" type="model" pid="1" pindex="0">');
    expect(xml).toContain('<item objectid="1" />');
  });
});
