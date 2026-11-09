'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { useAppStore } from '@/store/app-store';
import { compileModel } from '@/lib/engine/build123d-client';
import { PRELUDE_VERSION } from '@/lib/brep/prelude';
import {
  Play,
  Copy,
  Check,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  FileCode,
} from 'lucide-react';

export const PRELUDE_NOTE = "Helpers like _round and _bevel come from the tool's prelude; edit only the design code.";

export interface MarkerData {
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
  message: string;
  severity: 'error';
}

export function buildCompileMarkers(
  error: string | null,
  line: number | null,
  lineCount: number
): MarkerData[] {
  if (!error || line === null || line === undefined || line <= 0 || lineCount <= 0) {
    return [];
  }

  const lines = error.split('\n').map((l) => l.trim()).filter(Boolean);
  const message = lines.length > 0 ? lines[lines.length - 1] : error;
  const clampedLine = Math.max(1, Math.min(line, lineCount));

  return [
    {
      startLineNumber: clampedLine,
      endLineNumber: clampedLine,
      startColumn: 1,
      endColumn: 1000,
      message,
      severity: 'error',
    },
  ];
}

const MONACO_SYNTAX_RULES = [
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
];

type MonacoEditor = Parameters<NonNullable<React.ComponentProps<typeof Editor>['onMount']>>[0];

/** The editor's compile: the body plus the viewed version's preludeVersion. */
export async function compileEditorCode(body: string): Promise<void> {
  const { threads, activeThreadId, viewingVersion, setCompileStatus, setCompileResult } =
    useAppStore.getState();
  const currentThread = threads.find((t) => t.id === activeThreadId);
  const version = currentThread?.versions?.find((v) => v.version === viewingVersion);
  const preludeVersion = version?.preludeVersion ?? PRELUDE_VERSION;
  setCompileStatus('compiling');
  const result = await compileModel(body, { preludeVersion });
  setCompileResult(result);
}

export function CodeEditorPanel() {
  const {
    code,
    setCode,
    compileStatus,
    compileError,
    compileErrorLine,
    isGenerating,
  } = useAppStore();

  const [editorValue, setEditorValue] = useState(code);
  const [editorReady, setEditorReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  // Sync editor value when store code changes from external source (e.g. AI generation)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditorValue(code);
  }, [code]);

  const handleEditorWillMount = (monaco: Monaco) => {
    let fg = '#eef1f6';
    let accentFrom = '#6b9bff';
    if (typeof window !== 'undefined') {
      const styles = getComputedStyle(document.documentElement);
      const computedFg = styles.getPropertyValue('--fg').trim();
      if (computedFg) fg = computedFg;
      const computedAccent = styles.getPropertyValue('--accent-from').trim();
      if (computedAccent) accentFrom = computedAccent;
    }

    monaco.editor.defineTheme('cad-glass', {
      base: 'vs-dark',
      inherit: true,
      rules: MONACO_SYNTAX_RULES,
      colors: {
        'editor.background': '#00000000',
        'editor.foreground': fg,
        'editor.lineHighlightBackground': '#ffffff0a',
        'editorCursor.foreground': accentFrom,
        'editorWhitespace.foreground': '#ffffff14',
        'editorIndentGuide.background': '#ffffff10',
        'editorIndentGuide.activeBackground': '#ffffff25',
      },
    });
  };

  const handleEditorDidMount = (editor: MonacoEditor, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    setEditorReady(true);
    const model = editor.getModel();
    if (model) {
      const lineCount = model.getLineCount();
      const markers = buildCompileMarkers(compileError, compileErrorLine, lineCount);
      const monacoMarkers = markers.map((m) => ({
        startLineNumber: m.startLineNumber,
        endLineNumber: m.endLineNumber,
        startColumn: m.startColumn,
        endColumn: m.endColumn,
        message: m.message,
        severity: monaco.MarkerSeverity.Error,
      }));
      monaco.editor.setModelMarkers(model, 'cadai-compile', monacoMarkers);
    }
  };

  // Sync compile error markers to Monaco model
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;

    const lineCount = model.getLineCount();
    const markers = buildCompileMarkers(compileError, compileErrorLine, lineCount);
    const monacoMarkers = markers.map((m) => ({
      startLineNumber: m.startLineNumber,
      endLineNumber: m.endLineNumber,
      startColumn: m.startColumn,
      endColumn: m.endColumn,
      message: m.message,
      severity: monaco.MarkerSeverity.Error,
    }));

    monaco.editor.setModelMarkers(model, 'cadai-compile', monacoMarkers);
  }, [compileError, compileErrorLine, editorValue, editorReady]);

  const triggerRecompile = useCallback(
    async (codeToCompile: string) => {
      await compileEditorCode(codeToCompile);
    },
    []
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
    <div className="h-full flex flex-col bg-transparent min-w-0">
      {/* Editor toolbar header */}
      <div className="px-3.5 py-2 border-b border-[var(--glass-border)] flex items-center justify-between select-none bg-transparent">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="w-4 h-4 text-[var(--accent-from)] shrink-0" />
          <span className="text-xs font-semibold text-[var(--fg)] truncate">
            build123d Code
          </span>
          <span className="text-[10px] text-[var(--fg-muted)] font-mono hidden md:inline truncate">
            {isGenerating ? '(Streaming...)' : '(Live Sync)'}
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5 shrink-0 pr-8">
          {/* Status badge */}
          {compileStatus === 'compiling' && (
            <div className="flex items-center gap-1 text-[11px] text-[var(--accent-from)] font-mono">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="hidden sm:inline">Compiling...</span>
            </div>
          )}
          {compileStatus === 'success' && (
            <div className="flex items-center gap-1 text-[11px] text-[var(--fg)] font-mono">
              <CheckCircle2 className="w-3 h-3 text-[var(--accent-from)]" />
              <span className="hidden sm:inline">Synced</span>
            </div>
          )}
          {compileStatus === 'error' && (
            <div className="flex items-center gap-1 text-[11px] text-[var(--destructive)] font-mono">
              <AlertTriangle className="w-3 h-3 text-[var(--destructive)]" />
              <span className="hidden sm:inline">Error</span>
            </div>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-[var(--accent)] hover:bg-[var(--accent-glow)] border border-[var(--glass-border)] text-[var(--fg)] transition-colors cursor-pointer"
            title="Copy build123d Code"
          >
            {copied ? <Check className="w-3 h-3 text-[var(--accent-from)]" /> : <Copy className="w-3 h-3" />}
            <span className="text-[11px] hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
          </button>

          <button
            type="button"
            onClick={() => triggerRecompile(editorValue)}
            disabled={compileStatus === 'compiling'}
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-[image:var(--accent-gradient)] hover:opacity-90 text-[var(--fg)] font-medium shadow-xs transition-opacity cursor-pointer disabled:opacity-50"
            title="Recompile build123d Code"
          >
            <Play className="w-3 h-3 fill-current" />
            <span className="text-[11px]">Compile</span>
          </button>
        </div>
      </div>

      {/* Fixed prelude note */}
      <div className="px-3.5 py-1.5 border-b border-[var(--glass-border)] text-[11px] text-[var(--fg-muted)] select-none bg-transparent">
        {PRELUDE_NOTE}
      </div>

      {/* Monaco Editor Container */}
      <div className="flex-1 min-h-0 relative">
        <Editor
          height="100%"
          language="python"
          theme="cad-glass"
          value={editorValue}
          onChange={handleEditorChange}
          beforeMount={handleEditorWillMount}
          onMount={handleEditorDidMount}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: 'var(--font-geist-mono), monospace',
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
