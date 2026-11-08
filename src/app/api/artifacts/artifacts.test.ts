import { describe, it, expect, afterAll } from 'vitest';
import * as crypto from 'crypto';
import { NextRequest } from 'next/server';
import { closeDb } from '@/lib/db/db';
import { CADAI_OWNER_COOKIE } from '@/lib/owner';
import { put } from '@/lib/runs/owner-artifacts';
import { GET } from './[id]/route';

function makeOwner() {
  const uuid = crypto.randomUUID();
  const cookie = `${CADAI_OWNER_COOKIE}=${uuid}`;
  const key = crypto.createHash('sha256').update(uuid).digest('hex');
  return { uuid, cookie, key };
}

const req = (id: string, cookie?: string) =>
  GET(
    new NextRequest(`http://localhost/api/artifacts/${id}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ id }) }
  );

describe('GET /api/artifacts/:id', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('no owner returns 401', async () => {
    const res = await req('some-id');
    expect(res.status).toBe(401);
  });

  it("another owner's artifact → 404", async () => {
    const owner1 = makeOwner();
    const owner2 = makeOwner();
    const id = await put(owner1.key, 'stl', Buffer.from('solid test'));

    const res = await req(id, owner2.cookie);
    expect(res.status).toBe(404);
  });

  it('artifact responses are private, no-store', async () => {
    const owner = makeOwner();
    const bytes = Buffer.from('solid test mesh data');
    const id = await put(owner.key, 'stl', bytes);

    const res = await req(id, owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-type')).toBe('model/stl');
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('solid test mesh data');
  });

  it('serves step and image content types', async () => {
    const owner = makeOwner();
    const stepBytes = Buffer.from('STEP-DATA');
    const stepId = await put(owner.key, 'step', stepBytes);
    const stepRes = await req(stepId, owner.cookie);
    expect(stepRes.status).toBe(200);
    expect(stepRes.headers.get('content-type')).toBe('model/step');

    const imgBytes = Buffer.from('PNG-DATA');
    const imgId = await put(owner.key, 'image', imgBytes);
    const imgRes = await req(imgId, owner.cookie);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('content-type')).toBe('image/png');
  });

  it('unknown id returns 404', async () => {
    const owner = makeOwner();
    const res = await req('non-existent-id-22ch--', owner.cookie);
    expect(res.status).toBe(404);
  });
});
