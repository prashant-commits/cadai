import { NextRequest, NextResponse } from 'next/server';
import { compileScad } from '@/lib/engine/scad-compiler';
import { runBrep, type BrepPart } from '@/lib/engine/brep-runner';
import { detectLanguage } from '@/lib/brep/language';
import type { PartInfo } from '@/lib/contract/run-contract';
import { badRequest, compileFailed, errorBody, fromBrep } from '@/lib/contract/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function partInfo(parts: BrepPart[]): PartInfo[] {
  const out: PartInfo[] = [];
  for (const part of parts) {
    if (!part || typeof part.label !== 'string' || typeof part.valid !== 'boolean' || typeof part.volume !== 'number') continue;
    if (!Array.isArray(part.min) || part.min.length < 3 || !Array.isArray(part.max) || part.max.length < 3) continue;
    out.push({
      label: part.label,
      valid: part.valid,
      volume: part.volume,
      min: [part.min[0], part.min[1], part.min[2]],
      max: [part.max[0], part.max[1], part.max[2]],
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const code = body?.code;
    const requestedLanguage = body?.language;
    const language = requestedLanguage === 'build123d' || requestedLanguage === 'openscad'
      ? requestedLanguage
      : detectLanguage(typeof code === 'string' ? code : '');

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      const message = language === 'build123d' ? 'build123d code is required.' : 'OpenSCAD code is required.';
      return NextResponse.json(errorBody(badRequest(message)), { status: 400 });
    }

    if (language === 'build123d') {
      const result = await runBrep(code);
      if (!result.ok) {
        return NextResponse.json(
          errorBody(fromBrep(result.error || 'build123d compilation failed.')),
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
        parts: partInfo(result.parts ?? []),
      });
    }

    const result = await compileScad(code);

    if (!result.valid) {
      return NextResponse.json(
        errorBody(compileFailed(result.error || 'OpenSCAD compilation failed.')),
        { status: 422 }
      );
    }

    // OpenSCAD's compile result has no per-part measurements (those come from
    // runBrep). `parts` is omitted here; build123d responses include it.
    return NextResponse.json({
      success: true,
      stl: result.stl,
      language: 'openscad',
    });
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return NextResponse.json(errorBody(err), { status: 400 });
    }
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
      errorBody(new Error(`Compiler Error: ${message}`)),
      { status: 500 }
    );
  }
}
