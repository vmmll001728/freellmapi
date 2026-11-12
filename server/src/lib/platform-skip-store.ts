// Cross-request platform-skip cache (#D3), kept in its own DB-free module.
//
// A platform ruled out wholesale within one request (stale catalog 404,
// provider-level 5xx/timeout, or 3 distinct model_not_found) is remembered
// briefly so the NEXT request's router seeds skipPlatforms from it instead of
// re-paying the same dead-hop round trip. Entries are timestamped and
// lazy-expired; a successful attempt through the platform clears its entry so a
// recovered provider is usable again immediately. Deliberately conservative: a
// short TTL plus success-clearing keep a merely-flaky provider from being
// blacklisted for long.
//
// This lives separately from fallback-loop.ts on purpose: a vitest setupFile
// imports resetPlatformSkips to clear the cache between tests, and importing it
// must NOT drag the database module into the setup graph (that would create a
// separate db instance and poison every db-backed test). fallback-loop.ts
// re-exports the public surface so existing importers are unaffected.

export const CROSS_REQUEST_PLATFORM_SKIP_MS = 5 * 60_000;
const crossRequestPlatformSkips = new Map<string, number>();

export function recordPlatformSkip(platform: string, now: number = Date.now()): void {
  if (!platform) return;
  crossRequestPlatformSkips.set(platform, now + CROSS_REQUEST_PLATFORM_SKIP_MS);
}

export function collectPlatformSkips(now: number = Date.now()): Set<string> {
  const live = new Set<string>();
  for (const [platform, expiry] of crossRequestPlatformSkips) {
    if (expiry > now) live.add(platform);
    else crossRequestPlatformSkips.delete(platform);
  }
  return live;
}

export function clearPlatformSkip(platform: string): void {
  crossRequestPlatformSkips.delete(platform);
}

/** Drop every cross-request platform skip. Module state outlives a test case, so
 *  without this a case inherits the previous one's skipped platforms and the
 *  next request's seed becomes non-deterministic. Mirrors resetEmptyCompletionStreaks. */
export function resetPlatformSkips(): void {
  crossRequestPlatformSkips.clear();
}
