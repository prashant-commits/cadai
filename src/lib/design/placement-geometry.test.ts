import { describe, it, expect } from 'vitest';
import { rotatePoint, placedBounds, isZeroVec, Vec3 } from './placement-geometry';

const near = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('rotatePoint (OpenSCAD rotate([x, y, z]) order)', () => {
  it('rotate([90,0,0]) sends +y to +z', () => near(rotatePoint([0, 1, 0], [90, 0, 0]), [0, 0, 1]));
  it('rotate([-90,0,0]) sends +y to -z (the inverted-support bug)', () =>
    near(rotatePoint([0, 1, 0], [-90, 0, 0]), [0, 0, -1]));
  it('rotate([0,90,0]) sends +z to +x', () => near(rotatePoint([0, 0, 1], [0, 90, 0]), [1, 0, 0]));
  it('rotate([0,0,90]) sends +x to +y', () => near(rotatePoint([1, 0, 0], [0, 0, 90]), [0, 1, 0]));
  it('applies X, then Y, then Z', () => {
    // [1,0,0] -> Rx(90): [1,0,0] -> Ry(90): [0,0,-1] -> Rz(90): [0,0,-1]
    near(rotatePoint([1, 0, 0], [90, 90, 90]), [0, 0, -1]);
  });
});

describe('placedBounds', () => {
  const box = { min: [0, 0, 0] as Vec3, max: [10, 20, 30] as Vec3 };

  it('translates an unrotated box', () => {
    const b = placedBounds(box, [5, 6, 7], [0, 0, 0]);
    near(b.min, [5, 6, 7]);
    near(b.max, [15, 26, 37]);
  });

  it('rotate([-90,0,0]) hangs the box below the floor', () => {
    const b = placedBounds(box, [0, 0, 0], [-90, 0, 0]);
    near(b.min, [0, 0, -20]);
    near(b.max, [10, 30, 0]);
  });

  it('applies the local-frame correction before rotating', () => {
    // A module authored from z=-30..0 gets correction +30, then rotates.
    const hanging = { min: [0, 0, -30] as Vec3, max: [10, 20, 0] as Vec3 };
    const b = placedBounds(hanging, [0, 0, 5], [0, 0, 90], [0, 0, 30]);
    near(b.min, [-20, 0, 5]);
    near(b.max, [0, 10, 35]);
  });
});

describe('isZeroVec', () => {
  it('treats sub-epsilon noise as zero', () => {
    expect(isZeroVec([0.01, -0.02, 0])).toBe(true);
    expect(isZeroVec([0.1, 0, 0])).toBe(false);
  });
});
