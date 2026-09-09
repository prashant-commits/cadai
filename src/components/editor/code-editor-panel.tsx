'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import { useAppStore } from '@/store/app-store';
import { compileOpenScad } from '@/lib/engine/openscad-bridge';
import { OPENSCAD_LANGUAGE_ID, openscadLanguageDef } from '@/lib/editor/openscad-language';
import {
  Play,
  Copy,
  Check,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  FileCode,
  Printer,
} from 'lucide-react';

export function CodeEditorPanel() {
  const {
    code,
    setCode,
    compileStatus,
    compileError,
    setCompileResult,
    setCompileStatus,
    isGenerating,
    editorView,
    setEditorView,
  } = useAppStore();

  const [editorValue, setEditorValue] = useState(code);
  const [copied, setCopied] = useState(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Sync editor value when store code changes from external source (e.g. AI generation)
  useEffect(() => {
    setEditorValue(code);
  }, [code]);

  const handleEditorWillMount = (monaco: Monaco) => {
    // Register custom OpenSCAD language
    if (!monaco.languages.getLanguages().some((lang: { id: string }) => lang.id === OPENSCAD_LANGUAGE_ID)) {
      monaco.languages.register({ id: OPENSCAD_LANGUAGE_ID });
      monaco.languages.setMonarchTokensProvider(OPENSCAD_LANGUAGE_ID, openscadLanguageDef);

      // Register dark CAD theme
      monaco.editor.defineTheme('cad-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'keyword', foreground: '818cf8', fontStyle: 'bold' },
          { token: 'type', foreground: '38bdf8' },
          { token: 'keyword.flow', foreground: 'c084fc' },
          { token: 'support.function', foreground: '4ade80' },
          { token: 'variable.predefined', foreground: 'f472b6' },
          { token: 'variable', foreground: 'e2e8f0' },
          { token: 'number', foreground: 'fbbf24' },
          { token: 'number.float', foreground: 'fbbf24' },
          { token: 'string', foreground: 'a3e635' },
          { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
          { token: 'operator', foreground: 'f87171' },
        ],
        colors: {
          'editor.background': '#0b0f19',
          'editor.foreground': '#e2e8f0',
          'editor.lineHighlightBackground': '#1e293b50',
          'editorCursor.foreground': '#818cf8',
          'editorWhitespace.foreground': '#334155',
          'editorIndentGuide.background': '#1e293b',
          'editorIndentGuide.activeBackground': '#475569',
        },
      });
    }
  };

  const triggerRecompile = useCallback(
    async (codeToCompile: string) => {
      setCompileStatus('compiling');
      const result = await compileOpenScad(codeToCompile);
      setCompileResult(result);
    },
    [setCompileResult, setCompileStatus]
  );

  const handleEditorChange = (value?: string) => {
    const val = value || '';
    setEditorValue(val);
    setCode(val, undefined, 'user');

    // Debounce re-compilation by 500ms
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      triggerRecompile(val);
    }, 500);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(editorValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="h-full flex flex-col bg-[#0b0f19] border-t border-slate-800 min-w-0">
      {/* Editor toolbar header */}
      <div className="px-3.5 py-2 bg-slate-950 border-b border-slate-800 flex items-center justify-between select-none">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-xs font-semibold text-slate-200 truncate">OpenSCAD Code</span>
          <span className="text-[10px] text-slate-500 font-mono hidden md:inline truncate">
            {isGenerating ? '(Streaming...)' : '(Live Sync)'}
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Status badge */}
          {compileStatus === 'compiling' && (
            <div className="flex items-center gap-1 text-[11px] text-indigo-400 font-mono">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="hidden sm:inline">Compiling...</span>
            </div>
          )}
          {compileStatus === 'success' && (
            <div className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono">
              <CheckCircle2 className="w-3 h-3" />
              <span className="hidden sm:inline">Synced</span>
            </div>
          )}
          {compileStatus === 'error' && (
            <div className="flex items-center gap-1 text-[11px] text-rose-400 font-mono">
              <AlertTriangle className="w-3 h-3" />
              <span className="hidden sm:inline">Error</span>
            </div>
          )}

          {/* Toggle Design Panel button */}
          <button
            onClick={() => setEditorView(editorView === 'code' ? 'design' : 'code')}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors cursor-pointer ${
              editorView === 'design'
                ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                : 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title={editorView === 'code' ? 'Open Design Panel' : 'Hide Design Panel'}
          >
            <Printer className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-[11px] hidden sm:inline">Design</span>
          </button>

          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors cursor-pointer"
            title="Copy OpenSCAD Code"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span className="text-[11px] hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
          </button>

          <button
            onClick={() => triggerRecompile(editorValue)}
            disabled={compileStatus === 'compiling'}
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow-xs transition-colors cursor-pointer disabled:opacity-50"
            title="Recompile OpenSCAD Code"
          >
            <Play className="w-3 h-3 fill-current" />
            <span className="text-[11px]">Compile</span>
          </button>
        </div>
      </div>

      {/* Monaco Editor Container */}
      <div className="flex-1 min-h-0 relative">
        <Editor
          height="100%"
          language={OPENSCAD_LANGUAGE_ID}
          theme="cad-dark"
          value={editorValue}
          onChange={handleEditorChange}
          beforeMount={handleEditorWillMount}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
            lineNumbers: 'on',
            roundedSelection: false,
            scrollBeyondLastLine: false,
            readOnly: isGenerating,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            folding: true,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            bracketPairColorization: { enabled: true },
          }}
        />
      </div>
    </div>
  );
}
