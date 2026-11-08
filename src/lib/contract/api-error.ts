import type { ApiError, ErrorBody } from './run-contract';

const MODEL_UNAVAILABLE = 'The model provider is unavailable. Try again.';
const MODEL_ERROR = 'The model call failed.';
const TIMEOUT = 'The run exceeded its time budget.';
const INTERNAL = 'Something went wrong on the server.';
const GEOMETRY_UNAVAILABLE = 'The geometry service is unreachable.';
const GEOMETRY_TIMEOUT = 'The geometry service timed out.';
const GEOMETRY_FAILED = 'The geometry service failed to run the script.';

/** How a runBrep failure should be classified. Set by the runner from status and sentinels, not from traceback text. */
export type BrepFailure = 'script' | 'unreachable' | 'timeout';

const SKIP_ENV = new Set([
  'PATH', 'HOME', 'PWD', 'OLDPWD', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER', 'LOGNAME',
  'NODE_PATH', 'PYTHONPATH', 'NODE_ENV', 'VERCEL_ENV',
]);

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function badRequest(message: string): Error {
  return named('BadRequestError', message);
}

export function compileFailed(message: string): Error {
  return named('CompileError', message);
}

export function geometryFailed(message: string, opts?: { unreachable?: boolean }): Error {
  return named(opts?.unreachable ? 'GeometryUnavailableError' : 'GeometryFailedError', message);
}

/**
 * A runBrep `ok: false` result.
 * `failure` wins when the runner set it. Otherwise the string is classified from
 * sentinels (`timeout`, `HTTP 503`, `spawn … ENOENT`), never from a substring
 * like `timeout` inside a script traceback.
 */
export function fromBrep(message: string, failure?: BrepFailure): Error {
  const kind = classifyBrepFailure(message, failure);
  if (kind === 'timeout') return named('GeometryServiceTimeout', message);
  if (kind === 'unreachable') return geometryFailed(message, { unreachable: true });
  return geometryFailed(message);
}

export function classifyBrepFailure(message: string, failure?: string): BrepFailure {
  if (failure === 'script' || failure === 'unreachable' || failure === 'timeout') return failure;
  const text = message.trim();
  if (text === 'timeout') return 'timeout';
  if (text.startsWith('Traceback')) return 'script';
  if (/^HTTP (408|504)\b/.test(text)) return 'timeout';
  if (/^HTTP (502|503)\b/.test(text)) return 'unreachable';
  if (/^(?:Unauthorized|HTTP 401\b|HTTP 403\b)/.test(text)) return 'unreachable';
  if (/^spawn\b/.test(text) && /ENOENT/.test(text)) return 'unreachable';
  if (/^(?:connect\s+)?(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET)\b/.test(text)) return 'unreachable';
  if (text === 'ECONNREFUSED' || text === 'ENOTFOUND' || text === 'EAI_AGAIN' || text === 'ECONNRESET') return 'unreachable';
  if (text === 'fetch failed' || text === 'socket hang up' || text === 'network error') return 'unreachable';
  return 'script';
}

/** Strip secrets, env values, home directories, and absolute paths. Safe for UI text. */
export function sanitizeText(text: string): string {
  let out = text;
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[redacted]');
  out = out.replace(/\bbearer\s+[A-Za-z0-9._~+/-]{6,}/gi, 'bearer [redacted]');
  out = out.replace(/\bapi[_-]?key\s*[=:]\s*\S+/gi, 'api_key=[redacted]');
  const values = Object.entries(process.env)
    .filter(([key, value]) => {
      if (!value || value.length < 8 || SKIP_ENV.has(key)) return false;
      if (value.startsWith('/') || value.includes(':/')) return false;
      return true;
    })
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join('[redacted]');
  }
  out = out.replace(/\/(?:home|Users)\/[^\s'")\]]+/g, '[home]');
  // Absolute paths only. The slash must start the text or follow whitespace, a
  // quote, or `(`, so `a/b/c`, dates, and URLs are left alone. One segment
  // (`/in.py`) is not a filesystem path and stays.
  out = out.replace(/(^|[\s"'`(])(?:\/(?:[\w.+@=-]+)){2,}/g, '$1[path]');
  return out;
}

function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const rec = err as { status?: unknown; statusCode?: unknown };
  const raw = rec.status ?? rec.statusCode;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d{3}$/.test(raw)) return Number(raw);
  return undefined;
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string') {
    return (err as { name: string }).name;
  }
  return '';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return '';
}

function linesOf(text: string): string[] {
  return text.split('\n').map((part) => part.trim()).filter(Boolean);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function lastLine(text: string): string {
  const lines = linesOf(text);
  return lines[lines.length - 1] ?? '';
}

/** A compiler's useful diagnostic is the first `ERROR:` line. The last line is the generic "Can't parse file". */
function firstErrorLine(text: string): string {
  const lines = linesOf(text);
  return lines.find((line) => /^ERROR:/i.test(line)) ?? lines[0] ?? '';
}

function isJsonSyntax(message: string): boolean {
  return /Unexpected token|Unexpected end of JSON|after JSON|is not valid JSON|\bJSON\b/.test(message);
}

function className(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof ctor === 'string' ? ctor : '';
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code) return code;
  const cause = (err as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return '';
  const nested = (cause as { code?: unknown }).code;
  return typeof nested === 'string' ? nested : '';
}

const CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET']);

/**
 * Provider and client timeouts. Matched on the error class or `code`, never on
 * `name === 'Error'` (the Anthropic SDK leaves `name` as `'Error'`) and never
 * on the word "timeout" inside some other message.
 */
function isProviderTimeout(err: unknown, name: string): boolean {
  const cls = className(err);
  if (cls === 'APIConnectionTimeoutError' || cls === 'TimeoutError' || name === 'TimeoutError') return true;
  const code = errorCode(err);
  return code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT';
}

/** The run's own deadline, as opposed to a provider timeout. */
function isRunBudget(err: unknown, name: string, message: string): boolean {
  const cls = className(err);
  if (name === 'DeadlineError' || cls === 'DeadlineError') return true;
  return (name === 'AbortError' || cls === 'AbortError') && /\bdeadline\b/i.test(message);
}

function isProviderConnection(err: unknown): boolean {
  if (className(err) === 'APIConnectionError') return true;
  if (CONNECTION_CODES.has(errorCode(err))) return true;
  return errorMessage(err) === 'fetch failed';
}

function isUserAbort(err: unknown, name: string): boolean {
  const cls = className(err);
  if (cls === 'APIUserAbortError' || name === 'APIUserAbortError') return true;
  if (name === 'AbortError' || cls === 'AbortError') return true;
  return errorCode(err) === 'ABORT_ERR';
}

function providerOverloaded(status: number | undefined, message: string): boolean {
  if (status === 429 || status === 529) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  return /overloaded|rate limit|too many requests/i.test(message);
}

/**
 * `compile_failed` uses the first `ERROR:` line.
 * `geometry_failed` keeps the last non-empty traceback line. Multi-line text,
 * or a line whose path was stripped, also fills `detail`.
 */
function scriptError(code: 'compile_failed' | 'geometry_failed', text: string, fallback: string): ApiError {
  const sanitized = sanitizeText(text);
  const picked = code === 'compile_failed' ? firstErrorLine(text) : lastLine(text);
  const message = clip(sanitizeText(picked) || fallback, 300);
  const many = linesOf(text).length > 1;
  const stripped = sanitizeText(lastLine(text)) !== lastLine(text);
  if (!many && !stripped) return { code, message };
  const detail = clip(sanitized.trim(), 2000);
  return detail && detail !== message ? { code, message, detail } : { code, message };
}

function withDetail(base: ApiError, raw: string): ApiError {
  const detail = clip(sanitizeText(raw).trim(), 2000);
  if (!detail || detail === base.message) return base;
  return { ...base, detail };
}

/**
 * Maps a thrown or tagged failure onto the run contract's ApiError.
 * `message` is safe to show. Provider payloads, server paths, and env values stay out of it.
 */
export function toApiError(err: unknown): ApiError {
  const name = errorName(err);
  const message = errorMessage(err);
  const status = httpStatus(err);

  if (name === 'BadRequestError') {
    return { code: 'bad_request', message: clip(message, 300) || 'The request body is invalid.' };
  }
  if (name === 'SyntaxError' && isJsonSyntax(message)) {
    return { code: 'bad_request', message: clip(sanitizeText(message), 300) || 'The request body is invalid.' };
  }
  if (name === 'CompileError') return scriptError('compile_failed', message, 'The script did not compile.');
  if (name === 'GeometryServiceTimeout') {
    return withDetail(
      { code: 'geometry_unavailable', message: GEOMETRY_TIMEOUT, retryable: true },
      message,
    );
  }
  if (name === 'GeometryUnavailableError') {
    return withDetail(
      { code: 'geometry_unavailable', message: GEOMETRY_UNAVAILABLE, retryable: true },
      message,
    );
  }
  if (name === 'GeometryFailedError') return scriptError('geometry_failed', message, GEOMETRY_FAILED);
  if (name === 'UnusableReplyError') {
    const stop = err && typeof err === 'object' && 'stop' in err ? String((err as { stop: unknown }).stop) : '';
    return {
      code: 'model_error',
      message: stop === 'refusal'
        ? 'The model refused the reply.'
        : 'The model reply was cut off before it finished.',
    };
  }
  if (isProviderTimeout(err, name)) return { code: 'timeout', message: TIMEOUT, retryable: true };
  if (isRunBudget(err, name, message)) return { code: 'timeout', message: TIMEOUT };
  if (isProviderConnection(err)) {
    return { code: 'model_unavailable', message: MODEL_UNAVAILABLE, retryable: true };
  }
  if (isUserAbort(err, name)) return { code: 'cancelled', message: 'The run was stopped.' };
  if (providerOverloaded(status, message)) {
    return { code: 'model_unavailable', message: MODEL_UNAVAILABLE, retryable: true };
  }
  if ((typeof status === 'number' && status >= 400) || /APIError|OpenAIError|RateLimit/i.test(name)) {
    return { code: 'model_error', message: MODEL_ERROR };
  }
  const detail = clip(sanitizeText(message).trim(), 2000);
  return detail ? { code: 'internal', message: INTERNAL, detail } : { code: 'internal', message: INTERNAL };
}

/** JSON body for every route error. `error` stays a string for old clients. */
export function errorBody(err: unknown): ErrorBody {
  const apiError = toApiError(err);
  return { error: apiError.message, apiError };
}

/** HTTP status for a compile-route failure. 400 is only a malformed request body. */
export function compileStatus(err: unknown): number {
  if (errorName(err) === 'GeometryServiceTimeout') return 504;
  const code = toApiError(err).code;
  if (code === 'bad_request') return 400;
  if (code === 'geometry_unavailable') return 503;
  if (code === 'compile_failed' || code === 'geometry_failed') return 422;
  if (code === 'timeout') return 504;
  return 500;
}
