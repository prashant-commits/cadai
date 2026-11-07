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
    expect(toApiError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })).code).not.toBe('timeout');
    expect(toApiError(Object.assign(new Error('Recursion limit of 25 reached'), { name: 'GraphRecursionError' })).code).toBe('internal');
  });

  it('maps an OpenSCAD compile failure to compile_failed', () => {
    const api = toApiError(compileFailed('Parser error in file /in.scad'));
    expect(api).toMatchObject({ code: 'compile_failed', message: 'Parser error in file /in.scad' });
  });

  it('classifies a runBrep error string as unreachable, service timeout, or script failure', () => {
    expect(toApiError(fromBrep('connect ECONNREFUSED 127.0.0.1:9'))).toMatchObject({
      code: 'geometry_unavailable',
      retryable: true,
    });
    expect(toApiError(fromBrep('timeout'))).toMatchObject({ code: 'geometry_unavailable', retryable: true });
    expect(toApiError(fromBrep('timeout')).code).not.toBe('timeout');
    expect(toApiError(fromBrep('SyntaxError: bad indent')).code).toBe('geometry_failed');
    expect(toApiError(fromBrep('HTTP 503'))).toMatchObject({ code: 'geometry_unavailable', retryable: true });
    expect(toApiError(fromBrep('Unauthorized'))).toMatchObject({ code: 'geometry_unavailable', retryable: true });
    expect(toApiError(fromBrep("spawn /home/claude/work/wt-r2/geo/.venv/bin/python ENOENT"))).toMatchObject({
      code: 'geometry_unavailable',
      retryable: true,
    });
    expect(toApiError(fromBrep("spawn /home/claude/work/wt-r2/geo/.venv/bin/python ENOENT")).message).not.toMatch(/\/home\//);
    expect(toApiError(fromBrep("NameError: name 'timeout' is not defined"))).toMatchObject({
      code: 'geometry_failed',
      message: "NameError: name 'timeout' is not defined",
    });
  });

  it('puts the traceback exception line in message and a path-stripped tail in detail', () => {
    const tb = 'Traceback (most recent call last):\n  File "/tmp/cadai-brep-abc/model.py", line 3, in <module>\nValueError: wall too thin';
    const api = toApiError(fromBrep(tb));
    expect(api.code).toBe('geometry_failed');
    expect(api.message).toBe('ValueError: wall too thin');
    expect(api.detail).toContain('ValueError: wall too thin');
    expect(api.detail).not.toContain('/tmp/');
    expect(api.message).not.toBe('Traceback (most recent call last):');
  });

  it('keeps every line of a multi-line OpenSCAD error, with the last line as the message', () => {
    const api = toApiError(compileFailed('ERROR: Parser error in line 3\nERROR: second\nERROR: third'));
    expect(api).toMatchObject({ code: 'compile_failed', message: 'ERROR: third' });
    expect(api.detail).toContain('ERROR: Parser error in line 3');
    expect(api.detail).toContain('ERROR: second');
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
    const internal = toApiError(new Error('disk full'));
    expect(internal.code).toBe('internal');
    expect(internal.message).toBe('Something went wrong on the server.');
    expect(internal.detail).toBe('disk full');
    const leaked = toApiError(new Error("ENOENT: no such file or directory, open '/home/claude/work/wt-r2/.cadai/x.sqlite'"));
    expect(leaked.message).toBe('Something went wrong on the server.');
    expect(leaked.detail).not.toMatch(/\/home\//);
    expect(toApiError(new Error('Failed with header x-api-key: abcd1234 and token')).detail).not.toMatch(/abcd1234/);
    expect(toApiError(runExpired('This paused run expired or was not found on this server. Send the request again.')).code).toBe('run_expired');
    expect(toApiError(new SyntaxError('Unexpected end of JSON input')).code).toBe('bad_request');
    expect(toApiError(compileFailed('too many requests of module')).code).toBe('compile_failed');
    expect(toApiError({ weird: 1 }).message).toBe('Something went wrong on the server.');
  });

  it('treats provider 5xx and a string 429 as retryable model_unavailable without leaking the key', () => {
    expect(toApiError(Object.assign(new Error('x'), { status: 503 }))).toMatchObject({
      code: 'model_unavailable',
      retryable: true,
    });
    expect(toApiError(Object.assign(new Error('x'), { status: 500, name: 'InternalServerError' }))).toMatchObject({
      code: 'model_unavailable',
      retryable: true,
    });
    expect(toApiError(Object.assign(new Error('Request failed'), { status: '429' }))).toMatchObject({
      code: 'model_unavailable',
      retryable: true,
    });
    const key = toApiError(Object.assign(new Error('Incorrect API key sk-ant-abc123'), { status: 401 }));
    expect(key.code).toBe('model_error');
    expect(key.retryable).toBeUndefined();
    expect(JSON.stringify(key)).not.toMatch(/sk-ant/);
  });

  it('builds an ErrorBody whose error string matches apiError.message', () => {
    const body = errorBody(compileFailed('OpenSCAD compilation failed.'));
    expect(body.error).toBe(body.apiError.message);
    expect(body.apiError.code).toBe('compile_failed');
  });
});
