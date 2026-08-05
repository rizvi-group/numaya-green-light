import { defineApplication, FieldType } from 'twenty-sdk/define';

import {
  DEFAULT_LICENCE_API_BASE_URL,
  DEFAULT_LICENCE_ENVIRONMENT,
  LICENCE_API_BASE_URL_APP_VARIABLE_UNIVERSAL_IDENTIFIER,
  LICENCE_ENVIRONMENT_APP_VARIABLE_UNIVERSAL_IDENTIFIER,
} from 'src/constants/licence-identifiers';
import {
  APP_DESCRIPTION,
  APP_DISPLAY_NAME,
  APP_VARIABLE_UNIVERSAL_IDENTIFIERS,
  APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default defineApplication({
  universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
  displayName: APP_DISPLAY_NAME,
  description: APP_DESCRIPTION,
  author: 'Numaya',
  category: 'Sales',
  websiteUrl: 'https://numaya.ai',
  emailSupport: 'support@numaya.ai',

  // Configuration Layer 1. Layers 2 (CRM-editable config records) and 3 (field
  // mapping) live in workspace data, not here — see PRODUCT_SPEC.md.
  //
  // Secrets declare `isSecret: true` and carry no `value`: the workspace admin
  // supplies them after install, and Twenty keeps them out of the UI and logs.
  applicationVariables: {
    USE_TWENTY_AI: {
      universalIdentifier: APP_VARIABLE_UNIVERSAL_IDENTIFIERS.USE_TWENTY_AI,
      description:
        "Use Twenty's built-in AI for enrichment when the workspace has it configured. Falls back to the LLM_* variables below, then to rules-only scoring.",
      type: FieldType.BOOLEAN,
      value: true,
    },

    LLM_BASE_URL: {
      universalIdentifier: APP_VARIABLE_UNIVERSAL_IDENTIFIERS.LLM_BASE_URL,
      description:
        'Optional. OpenAI-compatible endpoint used only when Twenty AI is unavailable, e.g. https://api.openai.com/v1',
      type: FieldType.TEXT,
    },
    LLM_MODEL: {
      universalIdentifier: APP_VARIABLE_UNIVERSAL_IDENTIFIERS.LLM_MODEL,
      description:
        'Optional. Model name for the endpoint above, e.g. gpt-4o-mini or claude-sonnet-5.',
      type: FieldType.TEXT,
    },
    LLM_API_KEY: {
      universalIdentifier: APP_VARIABLE_UNIVERSAL_IDENTIFIERS.LLM_API_KEY,
      description: 'Optional. API key for the LLM endpoint above.',
      type: FieldType.TEXT,
      isSecret: true,
    },

    // SearXNG is listed first among the real options on purpose. It is the only
    // one that keeps the search half of enrichment inside the customer's own
    // infrastructure — no third-party account, no key to rotate, no per-query
    // bill, and no query text leaving the estate — which is the same property
    // that makes the rest of this app run inside their Twenty instance. The two
    // hosted providers remain for customers who would rather buy the capability
    // than run it.
    SEARCH_PROVIDER: {
      universalIdentifier: APP_VARIABLE_UNIVERSAL_IDENTIFIERS.SEARCH_PROVIDER,
      description:
        'Web search provider used to gather evidence before enrichment. SearXNG is self-hosted: no API key and no query text leaves your network. Leave as None to score on CRM data alone.',
      type: FieldType.SELECT,
      options: [
        { label: 'None', value: 'none' },
        { label: 'SearXNG (self-hosted)', value: 'searxng' },
        { label: 'Brave Search', value: 'brave' },
        { label: 'Serper', value: 'serper' },
      ],
      value: 'none',
    },
    SEARCH_API_KEY: {
      universalIdentifier: APP_VARIABLE_UNIVERSAL_IDENTIFIERS.SEARCH_API_KEY,
      description:
        'API key for the selected search provider. Required for Brave and Serper. SearXNG needs no key — leave this blank.',
      type: FieldType.TEXT,
      isSecret: true,
    },
    // Deliberately **not** secret, for the same reason LICENCE_API_BASE_URL is
    // not: it is an address, usually a private one like http://searxng:8080,
    // hiding it would only make a typo harder to diagnose, and there is nothing
    // on this path worth protecting — the provider has no credential at all.
    SEARCH_BASE_URL: {
      universalIdentifier: APP_VARIABLE_UNIVERSAL_IDENTIFIERS.SEARCH_BASE_URL,
      description:
        'Base URL of your SearXNG instance, including the scheme and without a trailing slash, e.g. http://searxng:8080. Required when the provider is SearXNG, ignored otherwise. The instance must allow the JSON output format: add "- json" under "search: formats:" in its settings.yml.',
      type: FieldType.TEXT,
    },

    MONTHLY_ENRICHMENT_CAP: {
      universalIdentifier:
        APP_VARIABLE_UNIVERSAL_IDENTIFIERS.MONTHLY_ENRICHMENT_CAP,
      description:
        'Maximum enrichment runs per calendar month. Reaching the cap disables enrichment for the rest of the month; scoring continues either way.',
      type: FieldType.NUMBER,
      value: 1000,
    },

    LICENCE_KEY: {
      universalIdentifier: APP_VARIABLE_UNIVERSAL_IDENTIFIERS.LICENCE_KEY,
      description:
        'Numaya licence key, e.g. NUMAYA-XXXXX-XXXXX-XXXXX-X. Without one the app runs in rules-only mode. Scoring never stops on a licence problem.',
      type: FieldType.TEXT,
      isSecret: true,
    },

    // The licensing service's public base URL, confirmed on 2026-08-04 against
    // the running service: its OpenAPI document is published at
    // `https://licensing.rizvigoc.com/openapi.json` and both endpoints this app
    // calls were exercised over real HTTPS. The previous default,
    // `license.numaya.ai`, never resolved — it was a placeholder that entered
    // our own documentation and was then cited by it.
    //
    // It stays a variable now that it is confirmed, because a customer running
    // a private Numaya deployment still has to point it elsewhere, and because
    // a wrong default should remain a settings change rather than a release.
    //
    // Deliberately **not** secret: it is an endpoint, hiding it would only make
    // a misconfiguration harder to diagnose, and the thing worth protecting on
    // this path is LICENCE_KEY above.
    LICENCE_API_BASE_URL: {
      universalIdentifier:
        LICENCE_API_BASE_URL_APP_VARIABLE_UNIVERSAL_IDENTIFIER,
      description:
        'Base URL of the Numaya licensing service, without a trailing slash. Only change this if Numaya support tells you to. If it is wrong the app runs in rules-only mode; scoring is unaffected.',
      type: FieldType.TEXT,
      value: DEFAULT_LICENCE_API_BASE_URL,
    },

    // Layer 1 rather than Layer 2, and the reasoning is worth stating because a
    // customer will never touch this variable:
    //
    //   - It cannot be derived from LICENCE_API_BASE_URL. One host serves both
    //     environments; the only thing that selects between them is a request
    //     header.
    //   - It cannot be a code constant. Our CI workspace and every throwaway
    //     dev container is licensed out of sandbox, so a constant would mean a
    //     code change and a republish to exercise a licensing change.
    //   - It cannot live in the CRM-editable GreenlightConfig record, because
    //     the post-install hook validates the licence before any Layer 2 record
    //     is guaranteed to exist — which is precisely the run where getting the
    //     environment wrong does the most damage.
    //
    // That is the identical argument that already put LICENCE_API_BASE_URL
    // here. Unrecognised values resolve to production, never to sandbox: see
    // `readLicenceEnvironment` in licence-run.ts.
    LICENCE_ENVIRONMENT: {
      universalIdentifier:
        LICENCE_ENVIRONMENT_APP_VARIABLE_UNIVERSAL_IDENTIFIER,
      description:
        'Which Numaya licensing environment holds this licence. Leave on Production unless Numaya support issued you a sandbox key — a sandbox licence is invisible to a production check and reports as if the licence did not exist.',
      type: FieldType.SELECT,
      options: [
        { label: 'Production', value: 'production' },
        { label: 'Sandbox', value: 'sandbox' },
      ],
      value: DEFAULT_LICENCE_ENVIRONMENT,
    },
  },
});
