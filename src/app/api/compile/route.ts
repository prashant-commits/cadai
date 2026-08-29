import { NextRequest, NextResponse } from 'next/server';
import { createOpenSCAD } from 'openscad-wasm';

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

    // Create a fresh instance for every request to avoid Emscripten MEMFS race conditions
    // and file locking (/input.scad and /output.stl) across concurrent requests.
    const instance = await createOpenSCAD();
    const stl = await instance.renderToStl(code);

    if (!stl || stl.trim().length === 0 || !stl.includes('facet normal')) {
      return NextResponse.json(
        { error: 'OpenSCAD produced an empty or zero-volume model (no facets).' },
        { status: 422 }
      );
    }

    return NextResponse.json({
      success: true,
      stl,
    });
  } catch (err: unknown) {
    let message = 'Unknown error';
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === 'object' && err !== null) {
      // openscad-wasm often throws an object with stderr or message properties
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
