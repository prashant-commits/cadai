import { describe, expect, it } from 'vitest';
import { badRequest, compileFailed, errorBody, fromBrep, geometryFailed, runExpired, toApiError } from './api-error';

describe('toApiError', () => {
  it('maps provider 429, 529, and overloaded to retryable model_unavailable', () => {
    expect(toApiError(Object.assign(new Error('slow down'), { status: 429 }))).toMatchObject({
      code: 'model_unavailable',
      retryable: true,
    });
    expect(toApiError(Object.assign(new Error('529 overloaded_error'), { status: 529 }))).toMatchObject({
      code: 'model_unavailable',
      retryable: true,
    });
    expect(toApiError(new Error('The model is overloaded'))).toMatchObject({
      code: 'model_unavailable',
      retryable: true,
    });
    expect(toApiError(Object.assign(new Error('slow down'), { status: 429 })).message).not.toMatch(/slow down/);
  });

  it('maps any other provider failure to model_error', () => {
    const api = toApiError(Object.assign(new Error('400 {"error":{"message":"giant provider payload"}}'), { status: 400, name: 'APIError' }));
    expect(api.code).toBe('model_error');
    expect(api.retryable).toBeUndefined();
    expect(api.message).not.toMatch(/giant provider payload/);
  });

  it('maps a deadline or timeout to timeout', () => {
    expect(toApiError(Object.assign(new Error('The run passed its deadline'), { name: 'DeadlineError' })).code).toBe('timeout');
    expect(toApiError(Object.assign(new Error('request timed out'), { name: 'TimeoutError' })).code).toBe('timeout');
  });

  it('maps an OpenSCAD compile failure to compile_failed', () => {
    const api = toApiError(compileFailed('Parser error in file /in.scad'));
    expect(api).toMatchObject({ code: 'compile_failed', message: 'Parser error in file /in.scad' });
  });

  it('classifies a runBrep error string as unreachable, deadline, or script failure', () => {
    expect(toApiError(fromBrep('connect ECONNREFUSED 127.0.0.1:9')).code).toBe('geometry_unavailable');
    expect(toApiError(fromBrep('timeout')).code).toBe('timeout');
    expect(toApiError(fromBrep('SyntaxError: bad indent')).code).toBe('geometry_failed');
  });

  it('maps a runBrep failure to geometry_failed and an unreachable service to geometry_unavailable', () => {
    expect(toApiError(geometryFailed('SyntaxError: bad indent'))).toMatchObject({
      code: 'geometry_failed',
      message: 'SyntaxError: bad indent',
    });
    expect(toApiError(geometryFailed('connect ECONNREFUSED 127.0.0.1:9', { unreachable: true }))).toMatchObject({
      code: 'geometry_unavailable',
      retryable: true,
    });
  });

  it('maps a bad body to bad_request and anything else to internal', () => {
    expect(toApiError(badRequest('Messages array is required.'))).toEqual({
      code: 'bad_request',
      message: 'Messages array is required.',
    });
    expect(toApiError(new SyntaxError('Unexpected token'))).toMatchObject({
      code: 'bad_request',
      message: 'Unexpected token',
    });
    expect(toApiError(new Error('disk full')).code).toBe('internal');
    expect(toApiError(runExpired('This paused run expired or was not found on this server. Send the request again.')).code).toBe('run_expired');
  });

  it('builds an ErrorBody whose error string matches apiError.message', () => {
    const body = errorBody(compileFailed('OpenSCAD compilation failed.'));
    expect(body.error).toBe(body.apiError.message);
    expect(body.apiError.code).toBe('compile_failed');
  });
});
