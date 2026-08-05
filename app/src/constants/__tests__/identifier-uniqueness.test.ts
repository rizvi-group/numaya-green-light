import { describe, expect, it } from 'vitest';

/**
 * The permanence guard, across every constants module — including the ones
 * nobody remembered to add.
 *
 * ## Why this file discovers its inputs instead of importing them
 *
 * This assertion used to live in `src/icp/__tests__/icp-identifiers.test.ts`,
 * hand-listing the modules it imported. By the time it was read again it
 * described itself as covering "all five constant files" while importing six,
 * and `enrichment-identifiers.ts` had never been added at all — so every
 * identifier in that module had been outside the collision guard since the day
 * it was written.
 *
 * That is the predictable failure of a cross-cutting invariant expressed as a
 * list: the guard only holds if whoever adds the eighth file also remembers a
 * test in a seventh directory. `import.meta.glob` removes the remembering.
 * A new `src/constants/*.ts` is covered by the act of existing.
 *
 * ## Why a collision matters more than it looks
 *
 * A `universalIdentifier` is the permanent primary key of a piece of app
 * metadata. Two definitions sharing one means the platform sees a single
 * entity described twice, and which description wins is a function of build
 * order rather than intent — on an already-installed workspace that reads as a
 * field changing type, or a page silently pointing at the wrong component. It
 * is not a class of bug that shows up locally, which is exactly why it is
 * asserted rather than reviewed.
 */

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Every constants module, resolved at build time by Vite rather than named
 * here. `eager` so the values are present synchronously and the test body stays
 * a plain assertion.
 */
/**
 * Declared locally rather than pulled in from `vite/client`. `import.meta.glob`
 * is a Vite transform, not a TypeScript language feature, and the app's
 * `tsconfig` deliberately does not carry Vite's ambient client types — adding
 * them here would put `ImportMetaEnv`, asset-module declarations and the rest of
 * that surface into the whole app's global scope to satisfy one test file.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { eager: true },
    ) => Record<string, Record<string, unknown>>;
  }
}

const modules: Record<string, Record<string, unknown>> = import.meta.glob(
  '../*.ts',
  { eager: true },
);

type Identifier = { path: string; value: string };

/**
 * Filtered on **shape**, not on key name. These modules also export SELECT
 * option values, route paths and request field names; folding those into the
 * guard would make the UUID assertion fail on data that was never an
 * identifier. Anything that looks like a v4 UUID is treated as one — a false
 * positive here would only ever tighten the guard, whereas a false negative
 * silently drops a real identifier out of it.
 */
const collect = (
  module: Record<string, unknown>,
  moduleName: string,
): Identifier[] => {
  const collected: Identifier[] = [];

  for (const [key, exported] of Object.entries(module)) {
    if (typeof exported === 'string') {
      if (UUID_V4.test(exported)) {
        collected.push({ path: `${moduleName}.${key}`, value: exported });
      }
      continue;
    }

    if (typeof exported === 'object' && exported !== null) {
      for (const [nested, value] of Object.entries(
        exported as Record<string, unknown>,
      )) {
        if (typeof value === 'string' && UUID_V4.test(value)) {
          collected.push({ path: `${moduleName}.${key}.${nested}`, value });
        }
      }
    }
  }

  return collected;
};

const all: Identifier[] = Object.entries(modules)
  .filter(([path]) => !path.includes('__tests__'))
  .flatMap(([path, module]) =>
    collect(module, path.replace('../', '').replace('.ts', '')),
  );

describe('universal identifiers, across every constants module', () => {
  it('should have discovered every constants module', () => {
    const discovered = Object.keys(modules)
      .map((path) => path.replace('../', ''))
      .sort();

    // Asserted by name as well as by count so that *deleting* a constants file
    // fails here rather than quietly shrinking the guard's coverage. Adding one
    // is meant to be a one-line change to this list; removing one should
    // require an argument.
    expect(discovered).toEqual([
      'backfill-identifiers.ts',
      'enrichment-identifiers.ts',
      'gate-queue-identifiers.ts',
      'icp-identifiers.ts',
      'licence-identifiers.ts',
      'logic-function-identifiers.ts',
      'next-action-kind-options.ts',
      'pipeline-identifiers.ts',
      'universal-identifiers.ts',
    ]);
  });

  it('should have collected a plausible number of identifiers', () => {
    // A floor, not an exact count: the point is to catch a `collect` regression
    // that silently returns nothing, which would make every assertion below
    // pass vacuously. An exact number would fail on every legitimate addition.
    expect(all.length).toBeGreaterThan(150);
  });

  it('should never reuse an identifier', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const { path, value } of all) {
      const previous = seen.get(value);

      if (previous !== undefined) {
        duplicates.push(`${previous} and ${path} share ${value}`);
      } else {
        seen.set(value, path);
      }
    }

    expect(duplicates).toEqual([]);
  });
});
