import { describe, it, expect } from 'vitest';
import { END } from '@langchain/langgraph';
import { routeAfterDesignerCheck } from './graph';
import type { AgentStateType } from './state';

describe('routeAfterDesignerCheck', () => {
  it('routes to designerNode on first failure when retry count is 1 and check is not completed', () => {
    const state = {
      isValid: false,
      designerRetryCount: 1,
      designerCheckCompleted: false,
    } as AgentStateType;

    expect(routeAfterDesignerCheck(state)).toBe('designerNode');
  });

  it('routes to END when valid', () => {
    const state = {
      isValid: true,
      designerRetryCount: 0,
      designerCheckCompleted: true,
    } as AgentStateType;

    expect(routeAfterDesignerCheck(state)).toBe(END);
  });

  it('routes to END on failure after the retry', () => {
    const state = {
      isValid: false,
      designerRetryCount: 2,
      designerCheckCompleted: true,
    } as AgentStateType;

    expect(routeAfterDesignerCheck(state)).toBe(END);
  });
});
