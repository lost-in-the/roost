import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from '@openclaw/gateway-protocol/schema';

export const settle = () => new Promise((r) => setTimeout(r, 10));

export function fakeGateway({ sessions = [], onRequest } = {}) {
  const state = { requests: [], requestParams: [], options: null, started: 0, stopped: 0, sessions };
  const create = (options) => {
    state.options = options;
    return {
      start() { state.started += 1; },
      stop() { state.stopped += 1; },
      request(method, params) {
        state.requests.push(method);
        state.requestParams.push({ method, params });
        if (onRequest) {
          const handled = onRequest(method, params, state);
          if (handled !== undefined) return handled;
        }
        if (method === 'sessions.list') return Promise.resolve({ sessions: state.sessions, count: state.sessions.length });
        if (method === 'sessions.viewers.set' && params.sessionKeys.length > SESSION_VIEWER_PRESENCE_MAX_KEYS) {
          return Promise.reject(new Error('Too many session keys'));
        }
        return Promise.resolve({});
      },
    };
  };
  return { create, state };
}
