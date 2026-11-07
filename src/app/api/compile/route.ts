import { NextRequest, NextResponse } from 'next/server';
import { compileScad } from '@/lib/engine/scad-compiler';
import { runBrep, type BrepPart } from '@/lib/engine/brep-runner';
import { detectLanguage } from '@/lib/brep/language';
import type { PartInfo } from '@/lib/contract/run-contract';
import { badRequest, compileFailed, compileStatus, errorBody, fromBrep } from '@/lib/contract/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function partInfo(parts: BrepPart[]): PartInfo[] {
  const out: PartInfo[] = [];
  let dropped = 0;
  for (const part of parts) {
    if (!part || typeof part.label !== 'string' || typeof part.valid !== 'boolean' || typeof part.volume !== 'number'
      || !Array.isArray(part.min) || part.min.length < 3 || !Array.isArray(part.max) || part.max.length < 3) {
      dropped += 1;
      continue;
    }
    out.push({
      label: part.label,
      valid: part.valid,
      volume: part.volume,
      min: [part.min[0], part.min[1], part.min[2]],
      max: [part.max[0], part.max[1], part.max[2]],
    });
  }
  if (dropped > 0) console.warn(`compile: dropped ${dropped} malformed part measurement(s)`);
  return out;
}

/** A JSON.parse failure is an internal bug, not the user's script. */
function isJsonSyntax(message: string): boolean {
  return /Unexpected token|Unexpected end of JSON|after JSON|is not valid JSON|\bJSON\b/.test(message);
}

export async function POST(req: NextRequest) {
  let body: { code?: unknown; language?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    const wrapped = err instanceof SyntaxError ? err : badRequest('The request body is invalid.');
    return NextResponse.json(errorBody(wrapped), { status: 400 });
  }

  let language: 'openscad' | 'build123d' = 'openscad';
  try {
    const code = body?.code;
    const requestedLanguage = body?.language;
    language = requestedLanguage === 'build123d' || requestedLanguage === 'openscad'
      ? requestedLanguage
      : detectLanguage(typeof code === 'string' ? code : '');

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      const message = language === 'build123d' ? 'build123d code is required.' : 'OpenSCAD code is required.';
      return NextResponse.json(errorBody(badRequest(message)), { status: 400 });
    }

    if (language === 'build123d') {
      const result = await runBrep(code);
      if (!result.ok) {
        const err = fromBrep(result.error || 'build123d compilation failed.', result.failure);
        return NextResponse.json(errorBody(err), { status: compileStatus(err) });
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
    // 422 only for a syntax error thrown by the OpenSCAD compiler while compiling
    // the user's script. A build123d failure, or an internal JSON.parse, is 500.
    const scriptSyntax = language === 'openscad' && err instanceof SyntaxError && !isJsonSyntax(err.message);
    const wrapped = scriptSyntax
      ? compileFailed(err.message || 'OpenSCAD compilation failed.')
      : err instanceof SyntaxError
        ? new Error(err.message)
        : err;
    return NextResponse.json(errorBody(wrapped), { status: compileStatus(wrapped) });
  }
}
