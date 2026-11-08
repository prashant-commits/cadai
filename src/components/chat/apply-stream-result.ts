import { StreamState, streamMessagePatch } from '@/lib/stream-reader';
import { useAppStore } from '@/store/app-store';
import { parseStlToGeometry } from '@/lib/engine/geometry-utils';
import { compileModel } from '@/lib/engine/build123d-client';

export async function applyStreamResult(
  state: StreamState,
  targetThreadId: string,
  messageId: string,
): Promise<void> {
  const store = useAppStore.getState();
  store.updateMessage(messageId, streamMessagePatch(state), targetThreadId);

  if (state.error) {
    store.setIsGenerating(false);
    store.setGeneratingThreadId(null);
    return;
  }

  if (state.designContract) store.setThreadContract(state.designContract, targetThreadId);

  if (state.code) {
    store.setCode(state.code, targetThreadId);
    if (state.stl && state.stl.includes('facet normal')) {
      const { geometry, modelInfo } = parseStlToGeometry(state.stl);
      store.setCompileResult(
        {
          success: true,
          stlContent: state.stl,
          geometry,
          modelInfo,
          compileTimeMs: 0,
          step: state.step,
          language: state.language,
        },
        targetThreadId,
      );
    } else {
      if (useAppStore.getState().activeThreadId === targetThreadId) store.setCompileStatus('compiling');
      const res = await compileModel(state.code);
      if (state.step && !res.step) res.step = state.step;
      store.setCompileResult(res, targetThreadId);
    }
  } else if (state.step) {
    store.setCompileResult({ success: true, step: state.step, language: state.language }, targetThreadId);
  }

  store.setIsGenerating(false);
  store.setGeneratingThreadId(null);
}
