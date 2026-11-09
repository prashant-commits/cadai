export const STARTER_IDEAS: readonly string[] = [
  'NEMA 17 motor mount with belt tensioner',
  'Raspberry Pi 5 enclosure with fan and port cutouts',
  '608 bearing pillow block, M5 bolts',
  '2020 extrusion corner bracket',
  'Hinged electronics box with cable gland',
  'GT2 idler pulley bracket for 2020 rail',
  'DIN rail mount for a 60 mm relay module',
  'M3 heat-set insert test block',
  'SMA antenna bulkhead mount plate',
  'Lead screw anti-backlash nut block for T8',
  'Cable chain link with snap-fit lid',
  'V-slot gantry plate with eccentric spacer holes',
  'MGN12 linear rail limit switch bracket',
  'Bowden extruder filament runout sensor body',
] as const;

export function pickTwo(rand: () => number = Math.random): [string, string] {
  const n = STARTER_IDEAS.length;
  const r1 = Math.min(Math.max(0, rand()), 0.999999999);
  const i = Math.floor(r1 * n);
  const r2 = Math.min(Math.max(0, rand()), 0.999999999);
  let j = Math.floor(r2 * (n - 1));
  if (j >= i) {
    j += 1;
  }
  return [STARTER_IDEAS[i], STARTER_IDEAS[j]];
}
