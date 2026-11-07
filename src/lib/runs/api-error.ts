import type { ApiError, ErrorBody, ErrorCode } from '@/lib/contract/run-contract';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  run_expired: 410,
  run_conflict: 409,
  cancelled: 409,
  model_unavailable: 503,
  model_error: 502,
  timeout: 504,
  compile_failed: 422,
  geometry_failed: 422,
  geometry_unavailable: 503,
  internal: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return STATUS[code];
}

export function errorBody(apiError: ApiError): ErrorBody {
  return { error: apiError.message, apiError };
}

/** A JSON error Response carrying an ErrorBody (`error` stays a string for old clients). */
export function errorResponse(code: ErrorCode, message: string, extra?: Partial<Omit<ApiError, 'code' | 'message'>>): Response {
  const apiError: ApiError = { code, message, ...extra };
  return new Response(JSON.stringify(errorBody(apiError)), {
    status: httpStatusFor(code),
    headers: { 'Content-Type': 'application/json' },
  });
}
