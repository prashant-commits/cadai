/**
 * Test helper: a mocked revision reply must differ geometrically from the
 * previous spec, or the revision-change check rightly rejects it. This lengthens
 * the first component (and the bounding box with it) a little more on every call.
 */
let revisionCalls = 0;

export function isRevisionCall(messages: unknown): boolean {
  return JSON.stringify(messages).includes('Revise this variant (');
}

export function distinctRevision<T>(reply: T): T {
  const spec = reply as { components?: Array<{ localExtents?: number[] }>; boundingBox?: { height?: number } } | null;
  if (!spec || !Array.isArray(spec.components) || !spec.components[0]?.localExtents) return reply;
  revisionCalls += 1;
  const grow = revisionCalls * 3; // 3 mm per call: well above the 0.5 mm signature rounding
  const [first, ...rest] = spec.components;
  const ext = [...first.localExtents!];
  ext[2] += grow; // the z extent: free for cylinders (axis z) and boxes alike
  return {
    ...spec,
    components: [{ ...first, localExtents: ext }, ...rest],
    boundingBox: spec.boundingBox ? { ...spec.boundingBox, height: (spec.boundingBox.height ?? 0) + grow } : spec.boundingBox,
  } as T;
}
