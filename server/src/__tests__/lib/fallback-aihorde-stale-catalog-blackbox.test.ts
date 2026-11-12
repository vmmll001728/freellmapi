import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AIHordeProvider } from '../../providers/aihorde.js';
import { runFallbackLoop, newFallbackState, type FallbackState, type RouteResult } from '../../lib/fallback-loop.js';
import { isStaleHordeCatalogError } from '../../lib/error-classify.js';
import { initDb } from '../../db/index.js';

// #P0-3 — complete server black-box for the stale AI Horde catalog skip.
//
// AI Horde's proxy answers a catalog row that no longer exists with a 404 whose
// body says "not known to this horde". That verdict applies to EVERY sibling
// model in the local catalog snapshot, so paying one dead-hop is enough: the
// platform is ruled out for the rest of the request (1 hop) instead of retrying
// each of the 3 configured models in turn (3 hops). issue #1218 / #D3.
//
// This test stands up a REAL local mock horde endpoint, points the REAL
// AIHordeProvider at it (via AIHORDE_BASE_URL), and drives a REAL
// runFallbackLoop with three aihorde models in the chain. A 1-hop skip means the
// provider is contacted exactly once; the old behavior would have hit it three
// times. No fetch is mocked — this is genuine end-to-end HTTP through the
// provider and the fallback loop.

let server: http.Server;
let hordeUrl: string;
let provider: AIHordeProvider;
let requestsToHorde = 0;

const STALE_BODY = JSON.stringify({
  detail:
    "The model 'koboldcpp/x' is not known to this horde: the text model reference does not list it and no online worker serves chat jobs",
});

beforeAll(async () => {
  // runFallbackLoop → recordRetryableFailure reads a routing setting via getDb.
  initDb(':memory:');
  // Local mock that always answers the horde 404 for chat completions.
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
      requestsToHorde += 1;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(STALE_BODY);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  hordeUrl = `http://127.0.0.1:${port}`;
  // Read by AIHordeProvider at construction time. The production default is
  // `https://oai.aihorde.net/v1` — the provider appends `/chat/completions`, so
  // the override must keep the `/v1` prefix.
  process.env.AIHORDE_BASE_URL = `${hordeUrl}/v1`;
  provider = new AIHordeProvider();
});

afterAll(() => {
  server?.close();
  delete process.env.AIHORDE_BASE_URL;
});

// Three aihorde models; the loop should reach only the first before ruling the
// whole platform out.
const chain: RouteResult[] = [1, 2, 3].map((n) => ({
  provider: provider as any,
  modelId: `koboldcpp/model-${n}`,
  modelDbId: 1000 + n,
  apiKey: 'no-key',
  keyId: 1000 + n,
  platform: 'aihorde',
  displayName: `Kobold ${n}`,
  rpdLimit: null,
  tpdLimit: null,
}) as RouteResult);

describe('stale AI Horde catalog is skipped in one hop (#P0-3 black-box)', () => {
  it('the real provider surfaces the stale-horde 404 over HTTP', async () => {
    requestsToHorde = 0;
    let thrown: any;
    try {
      await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'koboldcpp/x');
    } catch (err) {
      thrown = err;
    }
    expect(requestsToHorde).toBe(1);
    expect(thrown).toBeTruthy();
    expect(thrown.status).toBe(404);
    expect(isStaleHordeCatalogError(thrown)).toBe(true);
  });

  it('runFallbackLoop skips the aihorde platform after one stale-horde 404 (1 hop, not 3)', async () => {
    requestsToHorde = 0;
    const state: FallbackState = newFallbackState();
    let exhausted = false;
    let routingExhausted = false;
    let fatal = false;

    // The loop pulls candidates one at a time; the stale-horde 404 on the first
    // model must rule the platform out so the remaining two are never attempted.
    // Mirror the real router: it consults state.skipPlatforms and will not
    // hand back a candidate whose platform has been ruled out this request.
    let i = 0;
    const route = (): RouteResult => {
      while (i < chain.length) {
        const candidate = chain[i];
        if (!state.skipPlatforms.has(candidate.platform)) {
          i += 1;
          return candidate;
        }
        // Platform already ruled out by an earlier failure this request —
        // advance past it without paying another round trip.
        i += 1;
      }
      // No eligible candidate left → routing exhaustion (real router throws here).
      throw new Error('routing exhausted: aihorde platform ruled out, no other platform in chain');
    };
    await runFallbackLoop({
      state,
      maxRetries: 5,
      timeBudgetMs: 0,
      breakerLimit: 0,
      route,
      dispatch: async () => {
        // Mirror the real router's dispatch contract: perform the attempt and
        // translate a successful completion into the 'done' sentinel; a thrown
        // error (the stale-horde 404) propagates to the loop's failure path.
        await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'koboldcpp/x');
        return 'done';
      },
      logFailure: () => {},
      onFatal: () => { fatal = true; },
      onRoutingExhausted: () => { routingExhausted = true; },
      onExhausted: () => { exhausted = true; },
    });

    // Exactly one contact with the (broken) horde endpoint — not three.
    expect(requestsToHorde).toBe(1);
    expect(routingExhausted).toBe(true);
    expect(fatal).toBe(false);
    // The platform is now recorded as cross-request-skipped, so a follow-up
    // request would seed it without re-paying the dead hop.
    expect(state.skipPlatforms.has('aihorde')).toBe(true);
  });
});
