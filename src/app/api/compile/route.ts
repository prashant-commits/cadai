import { NextRequest, NextResponse } from 'next/server';
import { compileScad } from '@/lib/engine/scad-compiler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { code } = await req.json();

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return NextResponse.json(
        { error: 'OpenSCAD code is required.' },
        { status: 400 }
      );
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
    });
  } catch (err: unknown) {
    let message = 'Unknown error';
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === 'object' && err !== null) {
      message = (err as any).message || (err as any).stderr || JSON.stringify(err);
    } else {
      message = String(err);
    }

    return NextResponse.json(
      { error: `OpenSCAD Compiler Error: ${message}` },
      { status: 500 }
    );
  }
}
