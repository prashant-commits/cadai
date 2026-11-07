import { NextRequest, NextResponse } from 'next/server';
import { compileScad } from '@/lib/engine/scad-compiler';
import { runBrep } from '@/lib/engine/brep-runner';
import { detectLanguage } from '@/lib/brep/language';
import { createHash } from 'crypto';
import type { ResultArtifacts } from '@/lib/contract/run-contract';
import { getArtifactStore } from '@/lib/runs/artifact-store';

/**
 * Refs for a compile's outputs, stored under the synthetic run `compile-<sha of code>` (pruned by
 * the run TTL). A storage failure only drops the refs: the inline fields are the contract here.
 */
async function compileArtifacts(code: string, stl: string, stepBase64?: string): Promise<{ artifacts?: ResultArtifacts }> {
  try {
    const store = getArtifactStore();
    const runId = `compile-${createHash('sha256').update(code).digest('hex').slice(0, 24)}`;
    const artifacts: ResultArtifacts = {};
    if (stl) artifacts.stl = await store.put(runId, 'stl', stl);
    if (stepBase64) artifacts.step = await store.put(runId, 'step', Buffer.from(stepBase64, 'base64'));
    return Object.keys(artifacts).length > 0 ? { artifacts } : {};
  } catch (e) {
    console.warn('Compile artifact store failed; returning inline only:', e);
    return {};
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const code = body?.code;
    const requestedLanguage = body?.language;

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return NextResponse.json(
        { error: 'OpenSCAD code is required.' },
        { status: 400 }
      );
    }

    const language = requestedLanguage || detectLanguage(code);

    if (language === 'build123d') {
      const result = await runBrep(code);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error || 'build123d compilation failed.' },
          { status: 422 }
        );
      }

      let stlAscii = '';
      if (result.stl) {
        stlAscii = Buffer.from(result.stl, 'base64').toString('utf-8');
      }

      return NextResponse.json({
        success: true,
        stl: stlAscii,
        step: result.step,
        compileTimeMs: result.ms,
        language: 'build123d',
        ...(await compileArtifacts(code, stlAscii, result.step)),
      });
    }

    const result = await compileScad(code);

    if (!result.valid) {
      return NextResponse.json(
        { error: result.error || 'OpenSCAD compilation failed.' },
        { status: 422 }
      );
    }

    return NextResponse.json({
      success: true,
      stl: result.stl,
      language: 'openscad',
      ...(await compileArtifacts(code, result.stl ?? '')),
    });
  } catch (err: unknown) {
    let message = 'Unknown error';
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === 'object' && err !== null) {
      const errObj = err as Record<string, unknown>;
      message = (typeof errObj.message === 'string' ? errObj.message : '') ||
        (typeof errObj.stderr === 'string' ? errObj.stderr : '') ||
        JSON.stringify(err);
    } else {
      message = String(err);
    }

    return NextResponse.json(
      { error: `Compiler Error: ${message}` },
      { status: 500 }
    );
  }
}
