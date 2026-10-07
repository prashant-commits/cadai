import type { AssemblySpec } from '../agent/assembly-spec';

/**
 * One assembly that exercises every shape kind, a through hole, a blind hole,
 * a 90° rotation, an envelope guide and a line guide.
 *
 * Parts stay on z = 0. The rail's rotation about x swings its local z onto -y,
 * so its position.y absorbs that swing.
 */
export function fixtureSpec(): AssemblySpec {
  return {
    sheet: '',
    assemblyName: 'bench_block',
    boundingBox: { width: 130, length: 50, height: 42 },
    components: [
      {
        name: 'base_plate',
        description: 'Rectangular foot.',
        localExtents: [80, 50, 6],
        position: [0, 0, 0],
        shape: { kind: 'box' },
        holes: [{ d: 5, axis: 'z', at: [20, 25, 0], note: 'through the foot' }],
      },
      {
        name: 'post',
        description: 'Upright round post.',
        localExtents: [14, 14, 36],
        position: [6, 6, 6],
        shape: { kind: 'cylinder', axis: 'z' },
      },
      {
        name: 'sleeve',
        description: 'Short round spacer with a bore.',
        localExtents: [18, 18, 12],
        position: [56, 6, 6],
        shape: { kind: 'tube', axis: 'z', innerD: 8 },
      },
      {
        name: 'tray',
        description: 'Open-topped rectangular shell.',
        localExtents: [26, 16, 12],
        position: [6, 30, 6],
        shape: { kind: 'shell', wall: 2, openFace: '+Z' },
      },
      {
        name: 'link',
        description: 'Flat profile with an opening.',
        localExtents: [28, 16, 5],
        position: [40, 30, 6],
        shape: {
          kind: 'profile',
          plane: 'xy',
          points: [
            [0, 0],
            [28, 0],
            [28, 16],
            [0, 16],
          ],
          holes: [
            [
              [8, 5],
              [18, 5],
              [18, 11],
              [8, 11],
            ],
          ],
        },
        holes: [{ d: 3, axis: 'z', at: [4, 4, 5], depth: 3, note: 'blind from the top' }],
      },
      {
        name: 'rail',
        description: 'Bar turned 90 degrees about x.',
        localExtents: [40, 8, 8],
        position: [90, 8, 0],
        rotation: [90, 0, 0],
        shape: { kind: 'box' },
      },
    ],
    guides: [
      {
        label: 'keep_out',
        kind: 'envelope',
        localExtents: [20, 14, 10],
        position: [100, 20, 0],
      },
      {
        label: 'ridge',
        kind: 'line',
        points: [
          [0, 0, 42],
          [80, 0, 42],
          [80, 50, 42],
        ],
      },
    ],
    stressPoints: [],
    assumptions: [],
    openQuestions: [],
  };
}
