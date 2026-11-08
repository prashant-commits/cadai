import { describe, it, expect, vi, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import * as crypto from 'crypto';
import sharp from 'sharp';
import { POST } from './route';
import { BAD_ATTACHMENT } from '@/lib/persist/phrases';
import { CADAI_OWNER_COOKIE } from '@/lib/owner';
import { closeDb } from '@/lib/db/db';
import { openStream } from '@/lib/runs/owner-artifacts';

describe('POST /api/attachments', () => {
  const validOwnerUuid = crypto.randomUUID();
  const ownerCookie = `${CADAI_OWNER_COOKIE}=${validOwnerUuid}`;

  afterAll(async () => {
    await closeDb();
  });

  it('no owner cookie → 401', async () => {
    const fd = new FormData();
    fd.append('file', new File(['dummy'], 'test.png', { type: 'image/png' }));
    const req = new NextRequest('http://localhost:3000/api/attachments', {
      method: 'POST',
      body: fd,
      headers: {
        'content-length': '100',
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  describe('upload: magic bytes, Content-Length cap, 5 MB cap, a pixel bomb rejected, re-encoded to ≤1568 px PNG', () => {
    it('upload: magic bytes, Content-Length cap, 5 MB cap, a pixel bomb rejected, re-encoded to ≤1568 px PNG - a GIF / text renamed .png → 400', async () => {
      // 1. Text renamed .png
      const textFd = new FormData();
      textFd.append('file', new File(['this is plain text not a png'], 'fake.png', { type: 'image/png' }));
      const textReq = new NextRequest('http://localhost:3000/api/attachments', {
        method: 'POST',
        body: textFd,
        headers: {
          cookie: ownerCookie,
          'content-length': '150',
        },
      });
      const textRes = await POST(textReq);
      expect(textRes.status).toBe(400);
      expect(await textRes.json()).toEqual({
        error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
      });

      // 2. Real GIF generated with sharp (sent as image/png named image.png)
      const realGif = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#f00' },
      })
        .gif()
        .toBuffer();
      const gifFd = new FormData();
      gifFd.append('file', new File([realGif], 'image.png', { type: 'image/png' }));
      const gifReq = new NextRequest('http://localhost:3000/api/attachments', {
        method: 'POST',
        body: gifFd,
        headers: {
          cookie: ownerCookie,
          'content-length': String(realGif.length + 200),
        },
      });
      const gifRes = await POST(gifReq);
      expect(gifRes.status).toBe(400);
      expect(await gifRes.json()).toEqual({
        error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
      });

      // 3. Real TIFF generated with sharp (sent as image/png named image.png)
      const realTiff = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#f00' },
      })
        .tiff()
        .toBuffer();
      const tiffFd = new FormData();
      tiffFd.append('file', new File([realTiff], 'image.png', { type: 'image/png' }));
      const tiffReq = new NextRequest('http://localhost:3000/api/attachments', {
        method: 'POST',
        body: tiffFd,
        headers: {
          cookie: ownerCookie,
          'content-length': String(realTiff.length + 200),
        },
      });
      const tiffRes = await POST(tiffReq);
      expect(tiffRes.status).toBe(400);
      expect(await tiffRes.json()).toEqual({
        error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
      });
    });

    it('upload: magic bytes, Content-Length cap, 5 MB cap, a pixel bomb rejected, re-encoded to ≤1568 px PNG - Content-Length 5 MB + 64 KB + 1 → 400 and body never read', async () => {
      const overCap = 5 * 1024 * 1024 + 64 * 1024 + 1; // 5308417
      const fd = new FormData();
      fd.append('file', new File(['x'], 'test.png', { type: 'image/png' }));
      const req = new NextRequest('http://localhost:3000/api/attachments', {
        method: 'POST',
        body: fd,
        headers: {
          cookie: ownerCookie,
          'content-length': String(overCap),
        },
      });

      const formDataSpy = vi.spyOn(req, 'formData');
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
      });
      expect(formDataSpy).not.toHaveBeenCalled();
    });

    it('upload: magic bytes, Content-Length cap, 5 MB cap, a pixel bomb rejected, re-encoded to ≤1568 px PNG - a 5 MB + 1 byte file is rejected by 5 MB cap', async () => {
      // Valid base PNG from sharp
      const basePng = await sharp({
        create: { width: 10, height: 10, channels: 3, background: '#0f0' },
      })
        .png()
        .toBuffer();

      // 1. 5 MB + 1 byte valid PNG (base PNG + trailing zeroes ignored by libpng)
      const fiveMbPlus1 = 5 * 1024 * 1024 + 1;
      const largeBuf = Buffer.concat([basePng, Buffer.alloc(fiveMbPlus1 - basePng.length)]);

      const fd = new FormData();
      fd.append('file', new File([largeBuf], 'large.png', { type: 'image/png' }));
      const req = new NextRequest('http://localhost:3000/api/attachments', {
        method: 'POST',
        body: fd,
        headers: {
          cookie: ownerCookie,
          // Under the Content-Length cap (5MB + 64KB)
          'content-length': String(5 * 1024 * 1024 + 32 * 1024),
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
      });

      // 2. Exactly 5 MB - 1 bytes of the same valid image is accepted with 200
      const fiveMbMinus1 = 5 * 1024 * 1024 - 1;
      const validUnderCapBuf = Buffer.concat([basePng, Buffer.alloc(fiveMbMinus1 - basePng.length)]);

      const validFd = new FormData();
      validFd.append('file', new File([validUnderCapBuf], 'valid.png', { type: 'image/png' }));
      const validReq = new NextRequest('http://localhost:3000/api/attachments', {
        method: 'POST',
        body: validFd,
        headers: {
          cookie: ownerCookie,
          'content-length': String(5 * 1024 * 1024 + 32 * 1024),
        },
      });

      const validRes = await POST(validReq);
      expect(validRes.status).toBe(200);
      const validJson = await validRes.json();
      expect(validJson.artifactId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it('upload: magic bytes, Content-Length cap, 5 MB cap, a pixel bomb rejected, re-encoded to ≤1568 px PNG - a pixel bomb rejected', async () => {
      // 10000x5000 = 50,000,000 pixels > 40,000,000 limitInputPixels
      const bombBuf = await sharp({
        create: {
          width: 10000,
          height: 5000,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const fd = new FormData();
      fd.append('file', new File([bombBuf], 'bomb.png', { type: 'image/png' }));
      const req = new NextRequest('http://localhost:3000/api/attachments', {
        method: 'POST',
        body: fd,
        headers: {
          cookie: ownerCookie,
          'content-length': String(bombBuf.length + 500),
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
      });
    });

    it('upload: magic bytes, Content-Length cap, 5 MB cap, a pixel bomb rejected, re-encoded to ≤1568 px PNG - a 3000×2000 JPEG → 200 and stored object is a PNG whose long side is 1568', async () => {
      const jpegBuf = await sharp({
        create: {
          width: 3000,
          height: 2000,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .jpeg()
        .toBuffer();

      const fd = new FormData();
      fd.append('file', new File([jpegBuf], 'sample.jpg', { type: 'image/jpeg' }));
      const req = new NextRequest('http://localhost:3000/api/attachments', {
        method: 'POST',
        body: fd,
        headers: {
          cookie: ownerCookie,
          'content-length': String(jpegBuf.length + 500),
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.artifactId).toMatch(/^[A-Za-z0-9_-]{22}$/);

      // Verify the stored object
      const ownerKey = crypto.createHash('sha256').update(validOwnerUuid).digest('hex');
      const stored = await openStream(ownerKey, json.artifactId);
      expect(stored).not.toBeNull();
      expect(stored?.row.kind).toBe('image');

      const chunks: Buffer[] = [];
      for await (const chunk of stored!.stream) {
        chunks.push(chunk as Buffer);
      }
      const storedBuf = Buffer.concat(chunks);
      const meta = await sharp(storedBuf).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(1568);
      expect(meta.height).toBe(1045);
    });

    it('upload: magic bytes, Content-Length cap, 5 MB cap, a pixel bomb rejected, re-encoded to ≤1568 px PNG - a WebP → 200', async () => {
      const webpBuf = await sharp({
        create: {
          width: 800,
          height: 600,
          channels: 3,
          background: { r: 0, g: 0, b: 255 },
        },
      })
        .webp()
        .toBuffer();

      const fd = new FormData();
      fd.append('file', new File([webpBuf], 'sample.webp', { type: 'image/webp' }));
      const req = new NextRequest('http://localhost:3000/api/attachments', {
        method: 'POST',
        body: fd,
        headers: {
          cookie: ownerCookie,
          'content-length': String(webpBuf.length + 500),
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.artifactId).toMatch(/^[A-Za-z0-9_-]{22}$/);

      const ownerKey = crypto.createHash('sha256').update(validOwnerUuid).digest('hex');
      const stored = await openStream(ownerKey, json.artifactId);
      expect(stored).not.toBeNull();
      expect(stored?.row.kind).toBe('image');
    });
  });

  it('a truncated multipart body → BAD_ATTACHMENT', async () => {
    const truncatedBody = '------boundary\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\n';
    const req = new NextRequest('http://localhost:3000/api/attachments', {
      method: 'POST',
      body: truncatedBody,
      headers: {
        cookie: ownerCookie,
        'content-type': 'multipart/form-data; boundary=----boundary',
        'content-length': String(truncatedBody.length),
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
    });
  });

  it('rejects formData with non-file entries or multiple files with 400 BAD_ATTACHMENT', async () => {
    // 1. Extra field
    const fdExtra = new FormData();
    fdExtra.append('file', new File(['dummy'], 'test.png', { type: 'image/png' }));
    fdExtra.append('file2', new File(['dummy2'], 'test2.png', { type: 'image/png' }));
    const reqExtra = new NextRequest('http://localhost:3000/api/attachments', {
      method: 'POST',
      body: fdExtra,
      headers: { cookie: ownerCookie, 'content-length': '500' },
    });
    const resExtra = await POST(reqExtra);
    expect(resExtra.status).toBe(400);

    // 2. Wrong field name
    const fdWrong = new FormData();
    fdWrong.append('photo', new File(['dummy'], 'test.png', { type: 'image/png' }));
    const reqWrong = new NextRequest('http://localhost:3000/api/attachments', {
      method: 'POST',
      body: fdWrong,
      headers: { cookie: ownerCookie, 'content-length': '300' },
    });
    const resWrong = await POST(reqWrong);
    expect(resWrong.status).toBe(400);

    // 3. 0-byte file
    const fdEmpty = new FormData();
    fdEmpty.append('file', new File([], 'empty.png', { type: 'image/png' }));
    const reqEmpty = new NextRequest('http://localhost:3000/api/attachments', {
      method: 'POST',
      body: fdEmpty,
      headers: { cookie: ownerCookie, 'content-length': '150' },
    });
    const resEmpty = await POST(reqEmpty);
    expect(resEmpty.status).toBe(400);
    expect(await resEmpty.json()).toEqual({
      error: { code: 'bad_attachment', message: BAD_ATTACHMENT },
    });
  });
});
