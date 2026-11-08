import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { ownerKeyFrom } from '@/lib/owner';
import { BAD_ATTACHMENT } from '@/lib/persist/phrases';
import { put } from '@/lib/runs/owner-artifacts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CONTENT_LENGTH = 5 * 1024 * 1024 + 64 * 1024; // 5,308,416 bytes
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5,242,880 bytes

function badAttachmentResponse() {
  return NextResponse.json(
    { error: { code: 'bad_attachment', message: BAD_ATTACHMENT } },
    { status: 400 }
  );
}

function isSupportedImage(buf: Buffer): boolean {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return true;
  }
  // JPEG: FF D8 FF
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return true;
  }
  // WebP: RIFF????WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && // 'R'
    buf[1] === 0x49 && // 'I'
    buf[2] === 0x46 && // 'F'
    buf[3] === 0x46 && // 'F'
    buf[8] === 0x57 && // 'W'
    buf[9] === 0x45 && // 'E'
    buf[10] === 0x42 && // 'B'
    buf[11] === 0x50    // 'P'
  ) {
    return true;
  }
  return false;
}

export async function POST(req: NextRequest) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const clHeader = req.headers.get('content-length');
  if (!clHeader || clHeader.trim() === '') {
    return badAttachmentResponse();
  }
  const contentLength = Number(clHeader);
  if (
    !Number.isFinite(contentLength) ||
    !Number.isInteger(contentLength) ||
    contentLength < 0 ||
    contentLength > MAX_CONTENT_LENGTH
  ) {
    return badAttachmentResponse();
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return badAttachmentResponse();
  }

  const entries = Array.from(formData.entries());
  if (entries.length !== 1) {
    return badAttachmentResponse();
  }

  const [name, file] = entries[0];
  if (
    name !== 'file' ||
    typeof file !== 'object' ||
    file === null ||
    typeof (file as File).arrayBuffer !== 'function' ||
    typeof (file as File).size !== 'number'
  ) {
    return badAttachmentResponse();
  }

  const fileObj = file as File;
  if (fileObj.size === 0 || false) {
    return badAttachmentResponse();
  }

  let buf: Buffer;
  try {
    const arrayBuffer = await fileObj.arrayBuffer();
    buf = Buffer.from(arrayBuffer);
  } catch {
    return badAttachmentResponse();
  }

  if (buf.length === 0 || buf.length > MAX_FILE_SIZE) {
    return badAttachmentResponse();
  }

  if (!isSupportedImage(buf)) {
    return badAttachmentResponse();
  }

  let png: Buffer;
  try {
    png = await sharp(buf, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    return badAttachmentResponse();
  }

  try {
    const artifactId = await put(ownerKey, 'image', png);
    return NextResponse.json({ artifactId }, { status: 200 });
  } catch (err: unknown) {
    console.warn('Failed to store attachment:', err);
    return NextResponse.json(
      { error: { code: 'internal', message: 'Failed to store attachment.' } },
      { status: 500 }
    );
  }
}
