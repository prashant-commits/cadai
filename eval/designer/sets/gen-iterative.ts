import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SEED, type EvalPrompt, type FollowUp, type FollowUpKind } from '../types';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deterministic 32-bit PRNG
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BaseObjectSpec {
  id: string;
  name: string;
  request: string;
  compatiblePool: Partial<Record<FollowUpKind, FollowUp[]>>;
}

const BASE_OBJECTS: BaseObjectSpec[] = [
  {
    id: 'iter_box_with_lid',
    name: 'box with lid',
    request: 'A rectangular storage box 120 x 80 x 50 mm with a matching lift-off lid and 3 mm walls.',
    compatiblePool: {
      cut: [
        {
          text: 'Add a 15 mm circular cable hole centered at the back wall.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Is there a circular cable hole cut into the back wall?' },
        },
        {
          text: 'Add four 8 mm circular rubber-foot recesses on the underside.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Are there four circular rubber-foot recesses on the underside?' },
        },
      ],
      part: [
        {
          text: 'Add a central divider wall inside the box dividing it into two compartments.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'divider' },
        },
        {
          text: 'Add an ergonomic lift handle on top of the lid.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'handle' },
        },
      ],
      mechanism: [
        {
          text: 'Convert the lid to a hinged lid that rotates on pin hinges along the back edge.',
          kind: 'mechanism',
          probe: { kind: 'moves' },
        },
      ],
      global: [
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
        {
          text: 'Make it 30% wider along the X axis.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'x', ratio: 1.3, tolerance: 3 },
        },
      ],
      conflict: [
        {
          text: 'Add a slide-out drawer inside the same lower cavity where the main storage is located.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model resolve the conflict between the new drawer and the existing storage cavity?' },
        },
      ],
    },
  },
  {
    id: 'iter_phone_stand',
    name: 'phone stand',
    request: 'An angled desktop phone stand with an 80 x 100 mm backrest and a bottom retaining lip.',
    compatiblePool: {
      cut: [
        {
          text: 'Add a 12 mm wide charging cable slot through the bottom lip and backrest.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Is there a charging cable pass-through slot cut through the bottom lip?' },
        },
      ],
      part: [
        {
          text: 'Add an integrated headphone hanger hook on the rear of the stand.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'hook' },
        },
      ],
      mechanism: [
        {
          text: 'Add an adjustable tilt pivot joint allowing the backrest angle to tilt.',
          kind: 'mechanism',
          probe: { kind: 'moves' },
        },
      ],
      global: [
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
        {
          text: 'Make it 30% wider along the X axis.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'x', ratio: 1.3, tolerance: 3 },
        },
      ],
      conflict: [
        {
          text: 'Add a secondary tablet support ledge directly in front of the phone rest, overlapping the charging port area.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model cleanly resolve the spatial conflict between the secondary ledge and the existing rest?' },
        },
      ],
    },
  },
  {
    id: 'iter_desk_organizer',
    name: 'desk organizer',
    request: 'A compact desk organizer tray 200 x 120 x 40 mm with two stepped compartments.',
    compatiblePool: {
      cut: [
        {
          text: 'Add four 10 mm diameter pen holes drilled vertically into the upper step.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Are there circular pen holder holes cut into the upper step?' },
        },
      ],
      part: [
        {
          text: 'Add a phone resting cradle on the front left corner.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'cradle|phone' },
        },
        {
          text: 'Add an internal divider partitioning the large compartment in two.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'divider' },
        },
      ],
      mechanism: [
        {
          text: 'Add a small pull-out drawer underneath the rear elevated compartment.',
          kind: 'mechanism',
          probe: { kind: 'newPart', label: 'drawer' },
        },
      ],
      global: [
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
        {
          text: 'Make it 25 mm deeper along the Y axis.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'y', deltaMm: 25, tolerance: 2 },
        },
      ],
      conflict: [
        {
          text: 'Add a slide-out drawer inside the exact space where the front compartment cavity sits.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model resolve the conflict between the new drawer and the existing front compartment cavity?' },
        },
      ],
    },
  },
  {
    id: 'iter_wall_shelf',
    name: 'wall shelf',
    request: 'A floating wall shelf 260 x 120 x 30 mm with hidden rear wall-mounting brackets.',
    compatiblePool: {
      cut: [
        {
          text: 'Add two keyhole screw mounting slots in the rear wall plate.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Are there mounting slots cut into the rear plate?' },
        },
      ],
      part: [
        {
          text: 'Add three coat and bag hanging hooks along the bottom underside edge.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'hook' },
        },
      ],
      mechanism: [
        {
          text: 'Add a fold-down hinged extension shelf on the front.',
          kind: 'mechanism',
          probe: { kind: 'moves' },
        },
      ],
      global: [
        {
          text: 'Make it 30% wider along the X axis.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'x', ratio: 1.3, tolerance: 3 },
        },
        {
          text: 'Make it 20 mm deeper along the Y axis.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'y', deltaMm: 20, tolerance: 2 },
        },
      ],
      conflict: [
        {
          text: 'Add heavy diagonal wall brackets directly across the rear mounting plate area.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model integrate the diagonal brackets without colliding with the rear mounting structure?' },
        },
      ],
    },
  },
  {
    id: 'iter_headphone_stand',
    name: 'headphone stand',
    request: 'A desktop headphone stand with a weighted circular base, a vertical post, and a curved headband saddle.',
    compatiblePool: {
      cut: [
        {
          text: 'Add a cable wrapping notch cutout into the rear of the vertical post.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Is there a cable routing notch cut into the vertical post?' },
        },
      ],
      part: [
        {
          text: 'Add a small accessory tray on top of the base plate.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'tray' },
        },
      ],
      mechanism: [
        {
          text: 'Add a height adjustment telescoping collar mechanism with a lock screw.',
          kind: 'mechanism',
          probe: { kind: 'reviewer', question: 'Is there an adjustable collar or telescoping joint on the vertical post?' },
        },
      ],
      global: [
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
      ],
      conflict: [
        {
          text: 'Add an upright phone backrest directly where the center post connects to the base.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model resolve the overlap between the center post and the phone backrest?' },
        },
      ],
    },
  },
  {
    id: 'iter_small_enclosure',
    name: 'small enclosure',
    request: 'A two-piece project enclosure 95 x 65 x 30 mm consisting of a base box and snap-fit lid.',
    compatiblePool: {
      cut: [
        {
          text: 'Add a row of four ventilation slots along both side walls.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Are there ventilation slots cut into the side walls of the enclosure?' },
        },
        {
          text: 'Add an 8 x 14 mm rectangular USB connector cutout at the front wall.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Is there a rectangular cutout on the front wall?' },
        },
      ],
      part: [
        {
          text: 'Add four internal circuit board standoff pillars with 2.5 mm pilot holes.',
          kind: 'part',
          probe: { kind: 'reviewer', question: 'Are there internal PCB mounting standoff pillars in the corners?' },
        },
        {
          text: 'Add an external mounting flange on each side for wall mounting.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'flange|bracket' },
        },
      ],
      mechanism: [
        {
          text: 'Add cantilever snap-fit hooks on the lid that snap into recesses in the base.',
          kind: 'mechanism',
          probe: { kind: 'reviewer', question: 'Are there cantilever snap hooks engaging the base?' },
        },
      ],
      global: [
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
        {
          text: 'Make it 30% wider along the X axis.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'x', ratio: 1.3, tolerance: 3 },
        },
      ],
      conflict: [
        {
          text: 'Add solid internal battery compartments occupying the same space where the main board cavity is.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model resolve the conflict between the battery compartment and the board cavity?' },
        },
      ],
    },
  },
  {
    id: 'iter_planter',
    name: 'planter',
    request: 'A modern geometric desktop planter 85 x 85 x 75 mm with an internal soil chamber.',
    compatiblePool: {
      cut: [
        {
          text: 'Add three 6 mm drainage holes through the bottom floor.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Are there drainage holes through the bottom floor of the planter?' },
        },
      ],
      part: [
        {
          text: 'Add a matching nested drip saucer that fits snugly under the planter.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'saucer' },
        },
      ],
      mechanism: [
        {
          text: 'Add a snap-fit locking ring between the planter base and the drip saucer.',
          kind: 'mechanism',
          probe: { kind: 'reviewer', question: 'Is there a snap-fit retention ring holding the saucer to the planter?' },
        },
      ],
      global: [
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
      ],
      conflict: [
        {
          text: 'Add an integrated watering funnel spout running directly through the center of the planting chamber.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model route the watering funnel without obstructing the entire planting cavity?' },
        },
      ],
    },
  },
  {
    id: 'iter_lamp_base',
    name: 'lamp base',
    request: 'A weighted cylindrical desk lamp base 130 mm diameter and 35 mm height with a central socket hole.',
    compatiblePool: {
      cut: [
        {
          text: 'Add an 8 mm circular cord pass-through channel from the center out through the rear base rim.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Is there a cable routing channel exiting the rear rim of the base?' },
        },
      ],
      part: [
        {
          text: 'Add a rotary dimmer switch knob on the front sloping face.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'knob|switch' },
        },
      ],
      mechanism: [
        {
          text: 'Add an articulated ball-and-socket swivel mount at the top central socket.',
          kind: 'mechanism',
          probe: { kind: 'moves' },
        },
      ],
      global: [
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
      ],
      conflict: [
        {
          text: 'Add a pen cup recess directly into the center where the lamp socket and wiring pass through.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model offset or adapt the socket to fit the new pen cup without collision?' },
        },
      ],
    },
  },
  {
    id: 'iter_drawer_unit',
    name: 'drawer unit',
    request: 'A desktop single drawer unit: outer enclosure 150 x 120 x 80 mm with internal guide rails.',
    compatiblePool: {
      cut: [
        {
          text: 'Add two 10 mm cable pass-through holes at the upper back corners of the outer shell.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Are there cable holes cut into the rear corners of the outer shell?' },
        },
      ],
      part: [
        {
          text: 'Add a pull handle on the front face of the drawer.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'handle' },
        },
      ],
      mechanism: [
        {
          text: 'Add a second sliding drawer above the first one with matching guide rails.',
          kind: 'mechanism',
          probe: { kind: 'newPart', label: 'drawer' },
        },
      ],
      global: [
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
        {
          text: 'Make it 30% wider along the X axis.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'x', ratio: 1.3, tolerance: 3 },
        },
      ],
      conflict: [
        {
          text: 'Add a vertical partition wall extending through the middle of the drawer slide path.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model adapt the partition so the drawer can still slide open?' },
        },
      ],
    },
  },
  {
    id: 'iter_cable_tray',
    name: 'cable tray',
    request: 'An under-desk cable management tray 250 x 90 x 60 mm with open top and side wire pass-through fingers.',
    compatiblePool: {
      cut: [
        {
          text: 'Add mounting screw slots through the top mounting flanges.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Are there mounting slots through the top flanges?' },
        },
      ],
      part: [
        {
          text: 'Add a snap-on bottom power brick cradle under the tray.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'cradle|bracket' },
        },
      ],
      mechanism: [
        {
          text: 'Add a hinged swing-down release latch so the tray can pivot open for cable access.',
          kind: 'mechanism',
          probe: { kind: 'moves' },
        },
      ],
      global: [
        {
          text: 'Make it 30% wider along the X axis.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'x', ratio: 1.3, tolerance: 3 },
        },
      ],
      conflict: [
        {
          text: 'Add a solid closed top cover directly flush against the desk mounting surface.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model preserve cable insertion access despite the closed top cover?' },
        },
      ],
    },
  },
  {
    id: 'iter_pen_holder',
    name: 'pen holder',
    request: 'A cylindrical desk pen holder 75 mm diameter and 100 mm tall with a hollow interior.',
    compatiblePool: {
      cut: [
        {
          text: 'Add an angled 45-degree bevel cut to the top rim.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Does the top rim feature an angled or sloped rim cut?' },
        },
      ],
      part: [
        {
          text: 'Add a removable partitioned organizer insert dividing the cylinder into four quadrants.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'insert|divider' },
        },
      ],
      mechanism: [
        {
          text: 'Add a rotating turntable base bearing underneath allowing the cup to spin smoothly.',
          kind: 'mechanism',
          probe: { kind: 'moves' },
        },
      ],
      global: [
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
      ],
      conflict: [
        {
          text: 'Add a shallow memo pad holder ledge directly inside the pen cylinder cavity.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model arrange the memo ledge without completely blocking pen storage?' },
        },
      ],
    },
  },
  {
    id: 'iter_monitor_riser',
    name: 'monitor riser',
    request: 'A monitor riser stand 320 x 220 x 80 mm with dual side legs and open keyboard clearance underneath.',
    compatiblePool: {
      cut: [
        {
          text: 'Add two circular cable routing grommet holes through the rear of the top surface.',
          kind: 'cut',
          probe: { kind: 'reviewer', question: 'Are there circular cable pass-through holes through the rear of the top surface?' },
        },
      ],
      part: [
        {
          text: 'Add an accessory storage shelf suspended under the main riser platform.',
          kind: 'part',
          probe: { kind: 'newPart', label: 'shelf|tray' },
        },
      ],
      mechanism: [
        {
          text: 'Add a slide-out laptop or keyboard tray beneath the top platform.',
          kind: 'mechanism',
          probe: { kind: 'newPart', label: 'drawer|tray' },
        },
      ],
      global: [
        {
          text: 'Make it 30% wider along the X axis.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'x', ratio: 1.3, tolerance: 3 },
        },
        {
          text: 'Make it 20 mm taller.',
          kind: 'global',
          probe: { kind: 'spanChange', axis: 'z', deltaMm: 20, tolerance: 2 },
        },
      ],
      conflict: [
        {
          text: 'Add a solid center support pedestal directly in the middle of the keyboard clearance space.',
          kind: 'conflict',
          probe: { kind: 'reviewer', question: 'Did the model resolve the keyboard storage conflict with the center pedestal?' },
        },
      ],
    },
  },
];

/**
 * Generates the 12 iterative prompts according to the plan rules:
 * - 12 base objects
 * - Exactly 4 sequences with 1 follow-up, 4 with 2 follow-ups, and 4 with 3 follow-ups (total 24 follow-ups)
 * - Distinct kinds within each sequence
 * - At least 2 conflict follow-ups across the set
 * - Seeded by SEED (20261108)
 */
export function generateIterativeSet(seed: number = SEED): EvalPrompt[] {
  const rng = mulberry32(seed);

  // Follow-up counts: exactly 4 with 1, 4 with 2, 4 with 3
  const counts = [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3];
  // Shuffle counts deterministically
  for (let i = counts.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [counts[i], counts[j]] = [counts[j], counts[i]];
  }

  // Ensure at least 2 conflict follow-ups across the set
  // Pick 2 sequences that have count >= 2 to contain conflict follow-ups
  const multiIndices = counts
    .map((c, i) => (c >= 2 ? i : -1))
    .filter((i) => i !== -1);
  // Pick two distinct indices deterministically
  const conflictIdx1 = multiIndices[Math.floor(rng() * multiIndices.length)];
  let conflictIdx2 = multiIndices[Math.floor(rng() * multiIndices.length)];
  while (conflictIdx2 === conflictIdx1 && multiIndices.length > 1) {
    conflictIdx2 = multiIndices[(multiIndices.indexOf(conflictIdx1) + 1) % multiIndices.length];
  }

  const allKinds: FollowUpKind[] = ['cut', 'part', 'mechanism', 'global', 'conflict'];

  const prompts: EvalPrompt[] = [];

  for (let i = 0; i < BASE_OBJECTS.length; i++) {
    const obj = BASE_OBJECTS[i];
    const count = counts[i];
    const mustIncludeConflict = i === conflictIdx1 || i === conflictIdx2;

    // Select distinct kinds for this sequence
    const chosenKinds: FollowUpKind[] = [];
    if (mustIncludeConflict) {
      chosenKinds.push('conflict');
    }

    const availableKinds = allKinds.filter((k) => !chosenKinds.includes(k) && (obj.compatiblePool[k]?.length ?? 0) > 0);
    // Shuffle available kinds
    for (let k = availableKinds.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [availableKinds[k], availableKinds[j]] = [availableKinds[j], availableKinds[k]];
    }

    while (chosenKinds.length < count && availableKinds.length > 0) {
      chosenKinds.push(availableKinds.pop()!);
    }

    // Shuffle the order of chosen kinds
    for (let k = chosenKinds.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [chosenKinds[k], chosenKinds[j]] = [chosenKinds[j], chosenKinds[k]];
    }

    // Build followUps from chosenKinds
    const followUps: FollowUp[] = [];
    for (const kind of chosenKinds) {
      const pool = obj.compatiblePool[kind];
      if (pool && pool.length > 0) {
        const pick = pool[Math.floor(rng() * pool.length)];
        followUps.push(pick);
      }
    }

    prompts.push({
      id: obj.id,
      set: 'iterative',
      request: obj.request,
      followUps,
    });
  }

  return prompts;
}

// When executed directly, generate sets/iterative.json
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputPath = join(__dirname, 'iterative.json');
  const prompts = generateIterativeSet();
  writeFileSync(outputPath, JSON.stringify(prompts, null, 2));
  console.log(`Generated ${prompts.length} iterative prompts to ${outputPath}`);

  // Print stats for validation
  const countFreq: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  let totalConflicts = 0;
  let totalFollowUps = 0;
  for (const p of prompts) {
    const c = p.followUps?.length ?? 0;
    countFreq[c] = (countFreq[c] || 0) + 1;
    totalFollowUps += c;
    for (const f of p.followUps || []) {
      if (f.kind === 'conflict') totalConflicts++;
    }
  }
  console.log('Follow-up count distribution:', countFreq);
  console.log('Total follow-ups:', totalFollowUps);
  console.log('Total conflict follow-ups:', totalConflicts);
}
