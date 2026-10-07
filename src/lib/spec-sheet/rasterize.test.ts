import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { RasterizeError, svgToPngDataUrl } from './rasterize';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">
  <rect width="80" height="40" fill="#e11d48"/>
  <text x="4" y="24" font-size="16" fill="#111111">Hi</text>
</svg>`;

function pngBuffer(dataUrl: string): Buffer {
  expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
}

describe('svgToPngDataUrl', () => {
  it('returns a PNG data URL at the default density', async () => {
    const url = await svgToPngDataUrl(svg);
    const meta = await sharp(pngBuffer(url)).metadata();
    // 80x40 user units at 144 DPI is twice the 72 DPI pixel size.
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(160);
    expect(meta.height).toBe(80);
  });

  it('rescales proportionally when width is set', async () => {
    const url = await svgToPngDataUrl(svg, { width: 40 });
    const meta = await sharp(pngBuffer(url)).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(20);
  });

  it('honours an explicit density', async () => {
    const url = await svgToPngDataUrl(svg, { density: 72 });
    const meta = await sharp(pngBuffer(url)).metadata();
    expect(meta.width).toBe(80);
    expect(meta.height).toBe(40);
  });

  it('throws RasterizeError when the markup cannot be read', async () => {
    await expect(svgToPngDataUrl('<not-svg')).rejects.toBeInstanceOf(RasterizeError);
  });
});
