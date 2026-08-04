import type { GreenlightApiClient } from 'src/logic-functions/greenlight-api';

export interface RecordedCall {
  readonly kind: 'query' | 'mutation';
  readonly request: Record<string, unknown>;
}

export interface FakeClient extends GreenlightApiClient {
  readonly calls: RecordedCall[];
  mutationNames(): string[];
  queryNames(): string[];
  callsTo(name: string): Record<string, unknown>[];
}

type Responder = (request: Record<string, unknown>) => unknown;

/**
 * A hand-rolled stand-in for `CoreApiClient`.
 *
 * The real client is typed `any` and reads its credentials from the process
 * environment at construction time, so there is nothing to mock and nothing a
 * test can satisfy. Every handler in this folder therefore takes a
 * `GreenlightApiClient`, and this is what the tests pass instead.
 */
export const createFakeClient = (options: {
  query?: Responder;
  mutation?: Responder;
} = {}): FakeClient => {
  const calls: RecordedCall[] = [];

  const record = (kind: 'query' | 'mutation', request: Record<string, unknown>) => {
    calls.push({ kind, request });
  };

  const namesOf = (kind: 'query' | 'mutation'): string[] =>
    calls
      .filter((call) => call.kind === kind)
      .flatMap((call) => Object.keys(call.request));

  return {
    calls,
    async query(request) {
      record('query', request);

      return options.query?.(request) ?? {};
    },
    async mutation(request) {
      record('mutation', request);

      return options.mutation?.(request) ?? {};
    },
    mutationNames: () => namesOf('mutation'),
    queryNames: () => namesOf('query'),
    callsTo: (name) =>
      calls
        .filter((call) => name in call.request)
        .map((call) => call.request[name] as Record<string, unknown>),
  };
};

/** Wrap records in the `{ edges: [{ node }] }` connection shape Twenty returns. */
export const asConnection = (
  connectionName: string,
  nodes: readonly Record<string, unknown>[],
): Record<string, unknown> => ({
  [connectionName]: { edges: nodes.map((node) => ({ node })) },
});

/** The `data` argument of a recorded mutation. */
export const mutationData = (
  call: Record<string, unknown>,
): Record<string, unknown> => {
  const args = call['__args'] as Record<string, unknown> | undefined;

  return (args?.['data'] as Record<string, unknown>) ?? {};
};
