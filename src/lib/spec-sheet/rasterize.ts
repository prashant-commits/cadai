/**
 * SVG markup to a PNG data URL, for concept sheets.
 *
 * NODE ONLY. Uses sharp (a native module). Never import from a client component.
 */

import sharp from 'sharp';

/** Default SVG raster density. 144 keeps small text crisp. */
const DEFAULT_DENSITY = 144;

export class RasterizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RasterizeError';
  }
}

/**
 * SVG markup -> PNG data URL via sharp. `width` rescales proportionally.
 * Throws RasterizeError on failure.
 */
export async function svgToPngDataUrl(
  svg: string,
  opts?: { width?: number; density?: number }
): Promise<string> {
  const density = opts?.density ?? DEFAULT_DENSITY;
  try {
    let pipeline = sharp(Buffer.from(svg), { density });
    if (opts?.width !== undefined) {
      pipeline = pipeline.resize({ width: opts.width });
    }
    const png = await pipeline.png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RasterizeError(message);
  }
}
