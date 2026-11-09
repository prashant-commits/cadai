import { NextRequest, NextResponse } from 'next/server';
import { runBrep, type BrepPart } from '@/lib/engine/brep-runner';
import { checkPythonScript, MAX_SCRIPT_BYTES } from '@/lib/brep/body-check';
import { hasPreludeSentinel, withGeneratedPrelude, toBody, scriptLineToBodyLine, PRELUDE_VERSION, PRELUDES } from '@/lib/brep/prelude';
import type { PartInfo } from '@/lib/contract/run-contract';
import { badRequest, compileStatus, errorBody, fromBrep } from '@/lib/contract/api-error';
import { ownerKeyFrom } from '@/lib/owner';

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

export async function POST(req: NextRequest) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  let body: { code?: unknown; language?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    const wrapped = err instanceof SyntaxError ? err : badRequest('The request body is invalid.');
    return NextResponse.json(errorBody(wrapped), { status: 400 });
  }

  try {
    const requestedLanguage = body?.language;
    if (requestedLanguage !== undefined && requestedLanguage !== 'build123d') {
      return NextResponse.json(errorBody(badRequest('Only build123d scripts are supported.')), { status: 400 });
    }

    const code = body?.code;
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return NextResponse.json(errorBody(badRequest('build123d code is required.')), { status: 400 });
    }

    let finalCode: string;
    if (hasPreludeSentinel(code)) {
      finalCode = code;
    } else {
      const requestedVersion = (body as { preludeVersion?: unknown })?.preludeVersion;
      const version = typeof requestedVersion === 'string' ? requestedVersion : (requestedVersion === undefined ? PRELUDE_VERSION : 'invalid');
      if (!(version in PRELUDES)) {
        return NextResponse.json(errorBody(badRequest('Unknown prelude version.')), { status: 400 });
      }
      finalCode = withGeneratedPrelude(toBody(code), version);
    }

    if (Buffer.byteLength(finalCode, 'utf-8') > MAX_SCRIPT_BYTES) {
      return NextResponse.json(errorBody(badRequest('script too large')), { status: 400 });
    }

    const check = checkPythonScript(finalCode);
    if (!check.ok) {
      return NextResponse.json(errorBody(badRequest(check.reason)), { status: 400 });
    }
    const wantTopology = (body as { topology?: unknown })?.topology === true;
    const result = wantTopology
      ? await runBrep(finalCode, { topology: true })
      : await runBrep(finalCode);
    if (!result.ok) {
      const err = fromBrep(result.error || 'build123d compilation failed.', result.failure);
      const line =
        typeof result.line === 'number'
          ? scriptLineToBodyLine(result.line, finalCode)
          : null;
      const body = line !== null ? { ...errorBody(err), line } : errorBody(err);
      return NextResponse.json(body, { status: compileStatus(err) });
    }

    let stlAscii = '';
    if (result.stl) {
      stlAscii = Buffer.from(result.stl, 'base64').toString('utf-8');
    }

    const responsePayload: Record<string, unknown> = {
      success: true,
      stl: stlAscii,
      step: result.step,
      compileTimeMs: result.ms,
      language: 'build123d',
      parts: partInfo(result.parts ?? []),
    };
    if (wantTopology) {
      responsePayload.topology = result.topology;
    }

    return NextResponse.json(responsePayload);
  } catch (err: unknown) {
    const wrapped = err instanceof SyntaxError
      ? new Error(err.message)
      : err;
    return NextResponse.json(errorBody(wrapped), { status: compileStatus(wrapped) });
  }
}
