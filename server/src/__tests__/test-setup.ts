import { beforeEach } from 'vitest';
import { resetPlatformSkips } from '../lib/platform-skip-store.js';

// D3 introduced module-level cross-request platform-skip state (a Map keyed by
// platform that outlives a single test case). vitest's forks pool reuses worker
// processes across files, so that Map otherwise leaks from one test file into
// the next and silently changes routing. Reset it before every test so each
// case starts from a clean slate. The store is DB-free on purpose: importing it
// here must not pull the database module into the setup graph.
beforeEach(() => {
  resetPlatformSkips();
});
