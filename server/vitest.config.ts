import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Resets cross-request platform-skip state before every test so the
    // module-global Map (D3 circuit break) can't leak between test files. The
    // setup imports the DB-free platform-skip-store to avoid poisoning db tests.
    setupFiles: ['./src/__tests__/test-setup.ts'],
    // The Cloudflare neuron meter asks Cloudflare's analytics API for the
    // account's own count in the background; that call would land in every
    // test's fetch mock. Its own tests switch it back on.
    env: { CLOUDFLARE_NEURON_ANALYTICS: '0' },
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      enabled: process.env.COVERAGE === '1',
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/db/migrate/**', 'src/scripts/**', 'src/index.ts'],
      reporter: ['text', 'text-summary'],
    },
  },
});
