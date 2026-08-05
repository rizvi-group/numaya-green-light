import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * The **live** suite: real search engine, real model, real sockets.
 *
 * Kept in its own config and its own filename suffix (`*.live-test.ts`) so that
 * it cannot be picked up by `test:unit`, whose glob is `src/**\/*.test.ts`. The
 * unit suite must stay hermetic — a single live call in it would make CI depend
 * on somebody's laptop having a search instance running.
 *
 * Nothing here runs in CI. It is the manual proof that the ports work against
 * providers that can be slow, rate-limited, wrong, and occasionally hostile.
 */
export default defineConfig({
  plugins: [
    tsconfigPaths({
      projects: ['tsconfig.spec.json'],
      ignoreConfigErrors: true,
    }),
  ],
  test: {
    include: ['src/**/*.live-test.ts'],
    // A metasearch instance federates to several engines and a small local
    // model generates at a few tokens a second. Both are far outside a unit
    // test's budget and neither is a defect.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // The point of this suite is what it prints, not only whether it passes.
    reporters: ['verbose'],
  },
});
