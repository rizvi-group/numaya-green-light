/**
 * The OpenAI-compatible reasoning adapter — the fallback path, used when the
 * workspace has no Twenty AI configured.
 *
 * Implements `ReasoningPort`. No SDK import, `fetch` injected, never throws:
 * the same three properties `licence-http-client.ts` and
 * `enrich-search-client.ts` have, for the same reasons.
 *
 * ===========================================================================
 * ## Two messages, always
 *
 * ```
 *   [ { role: 'system', content: instruction },
 *     { role: 'user',   content: '<<UNTRUSTED …>>' + untrustedEvidence } ]
 * ```
 *
 * The instruction and the evidence are never concatenated. That is the first of
 * the five injection layers documented in `src/enrichment/sanitise.ts`, and it
 * is the one that has to hold at the wire, not in a comment — the port's
 * signature keeps them as separate arguments precisely so this adapter cannot
 * quietly join them.
 *
 * The evidence is additionally wrapped in a labelled block. Belt and braces: the
 * label costs a dozen tokens, and a model that ignores the system message may
 * still notice a fence that says the content inside is data.
 *
 * ## Model routing
 *
 * `LLM_MODEL` is a single application variable, so both tiers resolve to the
 * same model on this path. That is a real limitation and it is stated rather
 * than hidden: PRODUCT_SPEC's "cheap for verification, capable for briefings"
 * is only fully expressible on the Twenty-AI path, where two agents can point
 * at two models. Closing the gap needs a second application variable
 * (`LLM_MODEL_CHEAP`), which is Layer 1 configuration this module does not own.
 * `tier` is still carried through the port and still sets the token ceiling, so
 * adding that variable is a change to one line here and nothing else.
 *
 * ## Determinism
 *
 * `temperature: 0`. This is an extraction task with a right answer; sampling
 * buys variety, and variety in a field that will be written to a CRM is called
 * inconsistency. It also makes the tests that pin prompt behaviour meaningful.
 * ===========================================================================
 */

import { OPENAI_COMPATIBLE_CHAT_PATH } from 'src/constants/enrichment-identifiers';
import type {
  ProviderFailure,
  ReasoningOutcome,
  ReasoningPort,
} from 'src/enrichment';

export type ReasoningFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface OpenAiCompatibleClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: ReasoningFetchLike | null;
  /**
   * 20 seconds. The enrichment function is given 60s, of which the search has
   * already taken up to 6 and the verification call may take another 20. A
   * completion that has not landed in twenty seconds is a provider having a bad
   * day, and the right answer to that is to skip the lead, not to hold a worker.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The label wrapped around third-party content.
 *
 * Chosen to be something no real page would contain, and stripped from evidence
 * by `sanitiseUntrustedText` if it somehow did — so a snippet cannot forge the
 * closing fence and continue outside it.
 */
const UNTRUSTED_OPEN = '<<<UNTRUSTED_SEARCH_RESULTS_BEGIN>>>';
const UNTRUSTED_CLOSE = '<<<UNTRUSTED_SEARCH_RESULTS_END>>>';

export const wrapUntrusted = (evidence: string): string =>
  `${UNTRUSTED_OPEN}\n${evidence}\n${UNTRUSTED_CLOSE}`;

const describe = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return typeof error === 'string' ? error : 'unknown transport error';
};

const redactKey = (text: string, key: string): string =>
  key.length === 0 ? text : text.split(key).join('[redacted]');

const readRetryAfter = (headers: {
  get(name: string): string | null;
}): number | null => {
  const raw = headers.get('retry-after');

  if (raw === null) {
    return null;
  }

  const seconds = Number(raw.trim());

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

const classifyStatus = (
  status: number,
  headers: { get(name: string): string | null },
): ProviderFailure => {
  if (status === 429) {
    return { kind: 'rate_limited', retryAfterSeconds: readRetryAfter(headers) };
  }

  if (status >= 500) {
    return { kind: 'service_unavailable', statusCode: status };
  }

  return { kind: 'unexpected_status', statusCode: status };
};

const timeoutSignal = (timeoutMs: number): AbortSignal | undefined => {
  if (
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Pull the assistant message out of a chat completion.
 *
 * Tolerant of the two shapes in the wild — `message.content` as a string, and as
 * an array of content parts — because "OpenAI-compatible" is a family
 * resemblance, not a specification, and a gateway that returns parts is not
 * broken. Anything else is a `malformed_response`.
 */
export const readCompletionText = (payload: unknown): string | null => {
  if (!isRecord(payload) || !Array.isArray(payload['choices'])) {
    return null;
  }

  const [choice] = payload['choices'];

  if (!isRecord(choice) || !isRecord(choice['message'])) {
    return null;
  }

  const content = (choice['message'] as Record<string, unknown>)['content'];

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .flatMap((part): string[] =>
        isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : [],
      )
      .join('');

    return text.length === 0 ? null : text;
  }

  return null;
};

const normaliseBaseUrl = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '');

export const createOpenAiCompatibleClient = (
  options: OpenAiCompatibleClientOptions,
): ReasoningPort => {
  const baseUrl = normaliseBaseUrl(options.baseUrl ?? '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch =
    options.fetchImpl ??
    (typeof globalThis.fetch === 'function'
      ? (globalThis.fetch as unknown as ReasoningFetchLike)
      : null);

  return {
    providerName: 'openai-compatible',

    complete: async ({
      instruction,
      untrustedEvidence,
      maxOutputTokens,
    }): Promise<ReasoningOutcome> => {
      if (baseUrl.length === 0 || options.apiKey.length === 0 || options.model.length === 0) {
        return {
          kind: 'not_configured',
          detail: 'LLM_BASE_URL, LLM_API_KEY and LLM_MODEL must all be set',
        };
      }

      if (doFetch === null) {
        return {
          kind: 'transport_failure',
          detail: 'no fetch implementation available in this runtime',
        };
      }

      const body = JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: maxOutputTokens,
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: wrapUntrusted(untrustedEvidence) },
        ],
      });

      let response: Awaited<ReturnType<ReasoningFetchLike>>;

      try {
        response = await doFetch(`${baseUrl}${OPENAI_COMPATIBLE_CHAT_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body,
          signal: timeoutSignal(timeoutMs),
        });
      } catch (error) {
        return {
          kind: 'transport_failure',
          detail: redactKey(describe(error), options.apiKey),
        };
      }

      if (!response.ok) {
        return classifyStatus(response.status, response.headers);
      }

      let raw: string;

      try {
        raw = await response.text();
      } catch (error) {
        return {
          kind: 'malformed_response',
          detail: redactKey(describe(error), options.apiKey),
        };
      }

      let payload: unknown;

      try {
        payload = JSON.parse(raw) as unknown;
      } catch (error) {
        return {
          kind: 'malformed_response',
          detail: redactKey(describe(error), options.apiKey),
        };
      }

      const text = readCompletionText(payload);

      if (text === null) {
        return {
          kind: 'malformed_response',
          detail: 'no assistant content in the completion response',
        };
      }

      return { kind: 'completed', text, model: options.model };
    },
  };
};
