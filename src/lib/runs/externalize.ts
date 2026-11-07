import type { ArtifactRef, GateArtifacts, ResultArtifacts } from '@/lib/contract/run-contract';
import { getArtifactStore, type ArtifactStore } from './artifact-store';
import { inlinePayloads } from './config';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** put() that never fails the run: on a storage error the payload simply stays inline. */
async function tryPut(
  store: ArtifactStore,
  runId: string,
  kind: ArtifactRef['kind'],
  data: Uint8Array | string,
): Promise<ArtifactRef | undefined> {
  try {
    return await store.put(runId, kind, data);
  } catch (e) {
    console.warn(`Artifact store put failed (${kind}); keeping the payload inline:`, e);
    return undefined;
  }
}

/**
 * Moves the large payloads of a stream event into the artifact store and adds
 * `artifacts` refs. Inline fields (stl, step, sheetSvg) stay only while
 * CADAI_INLINE_PAYLOADS=1, or for a payload whose artifact could not be stored.
 * The input event is not mutated (the gate payload also lives in the checkpoint).
 */
export async function externalizeEvent<E extends Obj>(runId: string, event: E, store?: ArtifactStore): Promise<E> {
  if (event.t !== 'result' && event.t !== 'gate') return event; // nothing to externalize: never touch the store
  try {
    return await externalizeInner(runId, event, store ?? getArtifactStore());
  } catch (e) {
    // Never kill or stall a run over a storage problem: the event goes out with its inline payload.
    if (!warned) {
      warned = true;
      console.warn('Externalizing a payload failed; sending it inline:', e);
    }
    return event;
  }
}

let warned = false;

async function externalizeInner<E extends Obj>(runId: string, event: E, store: ArtifactStore): Promise<E> {
  const inline = inlinePayloads();
  if (event.t === 'result') {
    const out: Obj = { ...event };
    const artifacts: ResultArtifacts = {};
    if (nonEmpty(out.stl)) {
      const ref = await tryPut(store, runId, 'stl', out.stl);
      if (ref) {
        artifacts.stl = ref;
        if (!inline) delete out.stl;
      }
    }
    const stepBytes = nonEmpty(out.step) ? Buffer.from(out.step, 'base64') : undefined;
    if (stepBytes && stepBytes.subarray(0, 9).toString('latin1') === 'ISO-10303') {
      const ref = await tryPut(store, runId, 'step', stepBytes); // `step` is base64
      if (ref) {
        artifacts.step = ref;
        if (!inline) delete out.step;
      }
    }
    if (Object.keys(artifacts).length > 0) out.artifacts = artifacts;
    return out as E;
  }

  if (event.t === 'gate' && isObj(event.payload)) {
    const payload: Obj = { ...event.payload };
    const artifacts: GateArtifacts = {};
    if (Array.isArray(payload.variants)) {
      const sheets: Record<string, ArtifactRef> = {};
      payload.variants = await Promise.all(
        payload.variants.map(async (v: unknown) => {
          if (!isObj(v) || !nonEmpty(v.sheetSvg)) return v;
          const ref = await tryPut(store, runId, 'svg', v.sheetSvg);
          if (!ref) return v;
          if (typeof v.id === 'string') sheets[v.id] = ref;
          return inline ? v : { ...v, sheetSvg: null };
        }),
      );
      const ids = Object.keys(sheets);
      if (ids.length > 0) {
        artifacts.sheets = sheets;
        const rec = typeof payload.recommendedId === 'string' ? payload.recommendedId : undefined;
        if (rec && sheets[rec]) artifacts.sheetSvg = sheets[rec]; // only the recommended variant's sheet
      }
    }
    if (nonEmpty(payload.stl)) {
      const ref = await tryPut(store, runId, 'stl', payload.stl);
      if (ref) {
        artifacts.stl = ref;
        if (!inline) delete payload.stl;
      }
    }
    const out: Obj = { ...event, payload };
    if (Object.keys(artifacts).length > 0) out.artifacts = artifacts;
    return out as E;
  }
  return event;
}
