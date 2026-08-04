/**
 * The narrowest possible view of Twenty's Core API client.
 *
 * `CoreApiClient` from `twenty-client-sdk/core` is typed `any` until
 * `dev:generate-client` regenerates it against the installed workspace schema,
 * so depending on it directly buys no type safety and costs testability — the
 * class reads `API_URL` / `APP_ACCESS_TOKEN` from the process environment in its
 * constructor, which no unit test has.
 *
 * Everything in this folder therefore talks to `GreenlightApiClient`. The
 * `define*` files are the only place `new CoreApiClient()` appears, and they do
 * nothing but hand it to a handler that can be driven by a fake in tests.
 */

export interface GreenlightApiClient {
  query(request: Record<string, unknown>): Promise<unknown>;
  mutation(request: Record<string, unknown>): Promise<unknown>;
}

export const isPlainRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Twenty returns connections as `{ edges: [{ node }] }`. Pull the nodes out
 * without assuming the shape is correct — a schema drift should degrade to
 * "no records found", never throw.
 */
export const readConnectionNodes = (
  payload: unknown,
  connectionName: string,
): Record<string, unknown>[] => {
  if (!isPlainRecord(payload)) {
    return [];
  }

  const connection = payload[connectionName];

  if (!isPlainRecord(connection)) {
    return [];
  }

  const edges = connection['edges'];

  if (!Array.isArray(edges)) {
    return [];
  }

  return edges.flatMap((edge): Record<string, unknown>[] => {
    if (!isPlainRecord(edge)) {
      return [];
    }

    const node = edge['node'];

    return isPlainRecord(node) ? [node] : [];
  });
};

/** ISO-8601 sorts lexicographically, so this needs no Date parsing. */
export const oldestByCreatedAt = (
  records: readonly Record<string, unknown>[],
): Record<string, unknown> | null => {
  let oldest: Record<string, unknown> | null = null;
  let oldestKey: string | null = null;

  for (const record of records) {
    const createdAt = record['createdAt'];
    const key = typeof createdAt === 'string' ? createdAt : '';

    if (oldest === null || oldestKey === null || key < oldestKey) {
      oldest = record;
      oldestKey = key;
    }
  }

  return oldest;
};

/**
 * Structured log line. Logic functions have no logger injected — stdout is what
 * `yarn twenty dev:function:logs` shows — so everything Greenlight emits is a
 * single JSON object with a stable `event` key that support can grep for.
 */
export const logGreenlight = (
  event: string,
  detail: Record<string, unknown>,
): void => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ app: 'numaya-greenlight', event, ...detail }));
};

export const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
};
