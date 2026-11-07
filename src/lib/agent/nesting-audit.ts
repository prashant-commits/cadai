import type { AssemblySpec } from './assembly-spec';
import type { SpecViolation } from './spec-audit';

export interface NestingPart {
  label: string;
  min: readonly number[];
  max: readonly number[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Checks nesting and fit sanity for stacking or inserted parts.
 * Verifies that an inserted feature's bounding outline does not exceed the host opening.
 */
export function auditNesting(
  spec: AssemblySpec | null,
  parts: NestingPart[],
  request?: string
): SpecViolation[] {
  const violations: SpecViolation[] = [];
  if (!parts || parts.length === 0) return violations;

  const reqText = (request ?? '') + ' ' + (spec?.assemblyName ?? '');
  const isNestingRequested = /(?:fits\s+inside|nests\s+into|stacks\s+on|stackable|nesting|stack)/i.test(reqText);

  // 1. Stacking / nesting parts (e.g. stackable crate)
  if (isNestingRequested) {
    const lipPart = parts.find((p) => /lip|stack|nest|insert/i.test(p.label));
    if (lipPart) {
      const lipSizeX = round1(lipPart.max[0] - lipPart.min[0]);
      const lipSizeY = round1(lipPart.max[1] - lipPart.min[1]);

      let openingX: number | null = null;
      let openingY: number | null = null;

      // Method A: Check opposing walls if labelled
      const wallLeft = parts.find((p) => /left/i.test(p.label));
      const wallRight = parts.find((p) => /right/i.test(p.label));
      const wallFront = parts.find((p) => /front/i.test(p.label));
      const wallBack = parts.find((p) => /back/i.test(p.label));

      if (wallLeft && wallRight && wallRight.min[0] > wallLeft.max[0]) {
        openingX = round1(wallRight.min[0] - wallLeft.max[0]);
      }
      if (wallFront && wallBack && wallBack.min[1] > wallFront.max[1]) {
        openingY = round1(wallBack.min[1] - wallFront.max[1]);
      }

      // Method B: Check floor spec component if present
      if (openingX === null || openingY === null) {
        const floorComp = spec?.components?.find((c) => /floor/i.test(c.name));
        if (floorComp?.localExtents) {
          openingX = Number(floorComp.localExtents[0]);
          openingY = Number(floorComp.localExtents[1]);
        }
      }

      // Method C: Check boundingBox minus walls
      if (openingX === null || openingY === null) {
        if (spec?.boundingBox) {
          const wallParam = spec.parameters?.find((p) => /^wall(?:_t)?$/i.test(p.name))?.value ?? 3;
          openingX = round1(spec.boundingBox.width - 2 * wallParam);
          openingY = round1(spec.boundingBox.length - 2 * wallParam);
        }
      }

      if (openingX !== null && openingY !== null) {
        if (lipSizeX > openingX + 0.1 || lipSizeY > openingY + 0.1) {
          violations.push({
            kind: 'clearance',
            field: lipPart.label,
            expected: `<=${openingX}x${openingY} mm`,
            measured: `${lipSizeX}x${lipSizeY} mm`,
            severity: 'error',
            message: `Nesting fit violation: '${lipPart.label}' outline (${lipSizeX} x ${lipSizeY} mm) exceeds host opening (${openingX} x ${openingY} mm); cannot fit or nest into identical crate.`,
          });
        }
      }
    }
  }

  // 2. Joint contracts with clearances
  for (const j of spec?.jointContracts ?? []) {
    if (j.clearance && j.partA && j.partB) {
      const pA = parts.find((p) => p.label === j.partA);
      const pB = parts.find((p) => p.label === j.partB);
      if (pA && pB) {
        const sizeA = [round1(pA.max[0] - pA.min[0]), round1(pA.max[1] - pA.min[1])];
        const sizeB = [round1(pB.max[0] - pB.min[0]), round1(pB.max[1] - pB.min[1])];
        // If partB is a drawer or slider inside shell partA
        if (/slide|drawer|nest/i.test(j.type) || sizeB[0] < sizeA[0]) {
          const requiredAllowance = j.clearance * 2;
          // Inner part outline plus required clearance must fit within host dimensions
          if (sizeB[0] + requiredAllowance > sizeA[0] + 0.1) {
            violations.push({
              kind: 'clearance',
              field: j.partB,
              expected: `clearance ${j.clearance} mm`,
              measured: `exceeds host size`,
              severity: 'error',
              message: `Fit violation between '${j.partB}' (${sizeB[0]} mm) and host '${j.partA}' (${sizeA[0]} mm): clearance ${j.clearance} mm cannot be achieved.`,
            });
          }
        }
      }
    }
  }

  return violations;
}
