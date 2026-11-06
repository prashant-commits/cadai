import type { ApiError, ErrorBody } from './run-contract';

const MODEL_UNAVAILABLE = 'The model provider is unavailable. Try again.';
const MODEL_ERROR = 'The model call failed.';
const TIMEOUT = 'The run exceeded its time budget.';

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function badRequest(message: string): Error {
  return named('BadRequestError', message);
}

export function compileFailed(message: string): Error {
  return named('OpenSCADCompileError', message);
}

export function geometryFailed(message: string, opts?: { unreachable?: boolean }): Error {
  return named(opts?.unreachable ? 'GeometryUnavailableError' : 'GeometryFailedError', message);
}

export function runExpired(message: string): Error {
  return named('RunExpiredError', message);
}

/** A runBrep `ok: false` result: unreachable, timed out, or the script failed. */
export function fromBrep(message: string): Error {
  if (isUnreachable(message)) return geometryFailed(message, { unreachable: true });
  if (isDeadline(message)) return named('DeadlineError', message);
  return geometryFailed(message);
}

function isUnreachable(message: string): boolean {
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|unreachable|socket hang up|network error/i.test(message);
}

function isDeadline(message: string): boolean {
  return /\bdeadline\b|\btimed out\b|\btimeout\b/i.test(message);
}

function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const rec = err as { status?: unknown; statusCode?: unknown };
  if (typeof rec.status === 'number') return rec.status;
  if (typeof rec.statusCode === 'number') return rec.statusCode;
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

/** First line, capped, with obvious credentials stripped. */
function safeLine(text: string, fallback: string): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  if (!line || /sk-|api[_-]?key|bearer\s+[a-z0-9._-]+/i.test(line)) return fallback;
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/**
 * Maps a thrown or tagged failure onto the run contract's ApiError.
 * `message` is safe to show. Provider payloads stay out of it.
 */
export function toApiError(err: unknown): ApiError {
  const name = errorName(err);
  const message = errorMessage(err);
  const status = httpStatus(err);

  if (name === 'BadRequestError' || err instanceof SyntaxError) {
    return { code: 'bad_request', message: safeLine(message, 'The request body is invalid.') };
  }
  if (name === 'OpenSCADCompileError') {
    return { code: 'compile_failed', message: safeLine(message, 'OpenSCAD compilation failed.') };
  }
  if (name === 'GeometryUnavailableError') {
    return { code: 'geometry_unavailable', message: safeLine(message, 'The geometry service is unreachable.'), retryable: true };
  }
  if (name === 'GeometryFailedError') {
    return { code: 'geometry_failed', message: safeLine(message, 'The geometry service failed to run the script.') };
  }
  if (name === 'RunExpiredError') {
    return { code: 'run_expired', message: safeLine(message, 'This paused run expired or was not found on this server.') };
  }
  if (name === 'DeadlineError' || name === 'TimeoutError' || (name === 'AbortError' && isDeadline(message))) {
    return { code: 'timeout', message: TIMEOUT };
  }
  if (status === 429 || status === 529 || /overloaded|rate limit|too many requests/i.test(message)) {
    return { code: 'model_unavailable', message: MODEL_UNAVAILABLE, retryable: true };
  }
  if (isDeadline(message)) {
    return { code: 'timeout', message: TIMEOUT };
  }
  if ((typeof status === 'number' && status >= 400) || /APIError|OpenAIError|RateLimit/i.test(name)) {
    return { code: 'model_error', message: MODEL_ERROR };
  }
  return { code: 'internal', message: safeLine(message, 'Internal error.') };
}

/** JSON body for every route error. `error` stays a string for old clients. */
export function errorBody(err: unknown): ErrorBody {
  const apiError = toApiError(err);
  return { error: apiError.message, apiError };
}
