import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// #D3: cross-request platform-level circuit breaking. A platform ruled out
// wholesale within one request (provider-level 5xx/timeout, stale-catalog 404,
// or 3 distinct model_not_found) is remembered briefly so the NEXT request's
// router seeds skipPlatforms from it, and a successful attempt clears it.

import { initDb } from '../../db/index.js';
import {
  newFallbackState,
  recordRetryableFailure,
  runFallbackLoop,
  recordPlatformSkip,
  collectPlatformSkips,
  clearPlatformSkip,
  resetPlatformSkips,
  CROSS_REQUEST_PLATFORM_SKIP_MS,
  type FallbackState,
} from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';

let keySeq = 910000;
function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: 'fake-model', modelDbId: n, apiKey: 'k',
    keyId: n, platform: 'fake', displayName: 'Fake Model',
    rpdLimit: null, tpdLimit: null,
    ...overrides,
  };
}

const err500 = () => Object.assign(new Error('API error 500: internal error'), { status: 500 });
const errTimeout = () => new Error('Request timeout: no response from upstream');
const errStaleHorde = () =>
  Object.assign(new Error("The model 'koboldcpp/x' is not known to this horde: the text model reference does not list it"), { status: 404 });

describe('cross-request platform skip cache (#D3)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    resetPlatformSkips();
  });

  it('records, expires and self-prunes', () => {
    const now = 1_000;
    recordPlatformSkip('aihorde', now);
    expect(collectPlatformSkips(now).has('aihorde')).toBe(true);
    // After the TTL elapses the entry is gone and pruned from the map.
    const later = now + CROSS_REQUEST_PLATFORM_SKIP_MS + 1;
    expect(collectPlatformSkips(later).has('aihorde')).toBe(false);
    expect(collectPlatformSkips(later).size).toBe(0);
  });

  it('provider-level 5xx records the platform cross-request', () => {
    const now = 2_000;
    const state = newFallbackState();
    recordRetryableFailure(fakeRoute({ platform: 'aihorde' }), err500(), state, now);
    expect(state.skipPlatforms.has('aihorde')).toBe(true);
    expect(collectPlatformSkips(now).has('aihorde')).toBe(true);
  });

  it('provider-level timeout records the platform cross-request', () => {
    const now = 3_000;
    const state = newFallbackState();
    recordRetryableFailure(fakeRoute({ platform: 'broken' }), errTimeout(), state, now);
    expect(collectPlatformSkips(now).has('broken')).toBe(true);
  });

  it('stale horde catalog 404 records the platform cross-request', () => {
    const now = 4_000;
    const state = newFallbackState();
    recordRetryableFailure(fakeRoute({ platform: 'aihorde' }), errStaleHorde(), state, now);
    expect(state.skipPlatforms.has('aihorde')).toBe(true);
    expect(collectPlatformSkips(now).has('aihorde')).toBe(true);
  });

  it('clearPlatformSkip removes a platform from the cache', () => {
    const now = 5_000;
    recordPlatformSkip('aihorde', now);
    expect(collectPlatformSkips(now).has('aihorde')).toBe(true);
    clearPlatformSkip('aihorde');
    expect(collectPlatformSkips(now).has('aihorde')).toBe(false);
  });

  it('runFallbackLoop seeds cross-request skips and clears a healthy platform on success', async () => {
    const now = Date.now();
    // A prior request learned aihorde was broken; it should be seeded into the
    // next request's skipPlatforms automatically. Use real time so the loop's
    // own collectPlatformSkips() (also real time) sees it as still-live.
    recordPlatformSkip('aihorde', now);
    const state: FallbackState = newFallbackState();

    await runFallbackLoop({
      state,
      maxRetries: 1,
      timeBudgetMs: 0,
      breakerLimit: 0,
      route: () => fakeRoute({ platform: 'good' }),
      dispatch: async () => 'done',
      logFailure: () => {},
      onFatal: () => {},
      onRoutingExhausted: () => {},
      onExhausted: () => {},
    });

    // Seeded from the cache even though this request never touched aihorde.
    expect(state.skipPlatforms.has('aihorde')).toBe(true);
    // The platform this request actually succeeded on was cleared (still healthy).
    expect(state.skipPlatforms.has('good')).toBe(false);
    expect(collectPlatformSkips(now).has('aihorde')).toBe(true);
    expect(collectPlatformSkips(now).has('good')).toBe(false);
  });
});
