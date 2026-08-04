import { useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { defineFrontComponent } from 'twenty-sdk/define';
import {
  enqueueSnackbar,
  useRecordId,
  useSelectedRecordIds,
} from 'twenty-sdk/front-component';

import {
  ENRICH_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  ENRICH_LEAD_REQUEST_CLIENT_PATH,
} from 'src/constants/enrichment-identifiers';

/**
 * The enrichment panel — where "visually distinct from human data" stops being
 * a storage decision and becomes something a person can see.
 *
 * The storage half of that requirement is in
 * `src/fields/greenlight-enrichment.field.ts`: enriched values live in
 * Greenlight's own field and never in the customer's columns. This panel is the
 * other half. Every value is rendered with the page it came from, the date it
 * was read and a confidence, in a frame that says "sourced from the web" — so
 * the provenance is not something a curious admin can dig out of a JSON blob,
 * it is the only way the value is ever presented.
 *
 * ## Design decisions worth defending
 *
 *  - **The source is a link, not a hostname.** A hostname is reassuring and
 *    unverifiable. A link is checkable in one click, which is the entire point
 *    of recording it.
 *  - **Confidence is shown as a bar and a number.** The bar is read at a glance
 *    and the number survives a screenshot in a support thread.
 *  - **"Unconfirmed" is labelled, not hidden.** A value whose verification pass
 *    could not run is weaker, and the panel says so rather than rounding it up.
 *  - **Excluded pages are listed.** A search result dropped for carrying text
 *    addressed to the AI model is a security event about *this lead*, and it
 *    belongs in front of the person looking at the lead.
 *  - **The most common outcome is not an error.** Pressing the button usually
 *    returns "everything is already known", and the panel renders that as an
 *    explanation next to the existing sourced values, not as a failure.
 */

const ACCENT = '#6C47FF';
const MUTED = '#888';
const WARN = '#B54708';

const PANEL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  padding: '20px',
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: '13px',
  color: '#333',
};

const CARD_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '12px',
  borderRadius: '8px',
  border: `1px solid ${ACCENT}33`,
  background: `${ACCENT}0A`,
};

interface ProvenanceView {
  readonly value?: unknown;
  readonly sourceUrl?: unknown;
  readonly sourceTitle?: unknown;
  readonly retrievedAt?: unknown;
  readonly confidence?: unknown;
  readonly verification?: unknown;
}

interface SourceView {
  readonly url?: unknown;
  readonly title?: unknown;
  readonly quarantined?: unknown;
}

interface EnrichmentView {
  readonly fields?: Record<string, ProvenanceView>;
  readonly sources?: readonly SourceView[];
  readonly unresolved?: readonly string[];
  readonly notes?: readonly string[];
  readonly runAt?: unknown;
}

interface EnrichResponse {
  readonly ok?: boolean;
  readonly status?: string;
  readonly reason?: string | null;
  readonly message?: string;
  readonly fieldsWritten?: readonly string[];
  readonly enrichment?: EnrichmentView | null;
}

const FIELD_LABELS: Record<string, string> = {
  industry: 'Industry',
  region: 'Region',
  employeeCount: 'Employee count',
  jobTitle: 'Job title',
  seniority: 'Seniority',
};

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const formatDate = (value: unknown): string => {
  const raw = asText(value);

  if (raw === '') {
    return 'date unknown';
  }

  const parsed = Date.parse(raw);

  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : raw;
};

const hostOf = (url: string): string => {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url);

  return match?.[1] ?? url;
};

const serverMessage = (error: unknown): string => {
  const body = (error as { body?: unknown } | null)?.body;

  if (typeof body === 'object' && body !== null) {
    const message = (body as Record<string, unknown>)['message'];

    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }

  return error instanceof Error && error.message !== ''
    ? error.message
    : 'Something went wrong.';
};

const ConfidenceBar = ({ confidence }: { confidence: number }) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
    <span
      style={{
        display: 'inline-block',
        width: '56px',
        height: '4px',
        borderRadius: '2px',
        background: '#e6e6e6',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          display: 'block',
          width: `${Math.round(confidence * 100)}%`,
          height: '100%',
          background: confidence >= 0.7 ? ACCENT : WARN,
        }}
      />
    </span>
    <span style={{ color: MUTED, fontSize: '12px' }}>
      {Math.round(confidence * 100)}% confidence
    </span>
  </span>
);

const FieldCard = ({
  fieldKey,
  provenance,
}: {
  fieldKey: string;
  provenance: ProvenanceView;
}) => {
  const url = asText(provenance.sourceUrl);
  const confidence =
    typeof provenance.confidence === 'number' ? provenance.confidence : 0;
  const unconfirmed = provenance.verification === 'unconfirmed';

  return (
    <div style={CARD_STYLE}>
      <span style={{ color: MUTED, fontSize: '12px', letterSpacing: '0.02em' }}>
        {FIELD_LABELS[fieldKey] ?? fieldKey}
      </span>
      <span style={{ fontWeight: 600, fontSize: '14px' }}>
        {asText(provenance.value) || '—'}
      </span>

      <ConfidenceBar confidence={confidence} />

      <span style={{ color: MUTED, fontSize: '12px', lineHeight: 1.5 }}>
        Read {formatDate(provenance.retrievedAt)} from{' '}
        {url === '' ? (
          'an unrecorded source'
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: ACCENT }}
          >
            {asText(provenance.sourceTitle) || hostOf(url)}
          </a>
        )}
        {unconfirmed ? ' · not double-checked' : ''}
      </span>
    </div>
  );
};

const GreenlightEnrichLead = () => {
  const recordId = useRecordId();
  const selectedRecordIds = useSelectedRecordIds();

  const targetIds =
    selectedRecordIds.length > 0
      ? selectedRecordIds
      : recordId === null
        ? []
        : [recordId];

  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<EnrichResponse | null>(null);

  if (targetIds.length === 0) {
    return (
      <div style={PANEL_STYLE}>
        <strong>Nothing selected</strong>
        <span style={{ color: MUTED }}>
          Open a person, or select one in a list, then run Enrich now again.
        </span>
      </div>
    );
  }

  if (targetIds.length > 1) {
    return (
      <div style={PANEL_STYLE}>
        <strong>One person at a time</strong>
        <span style={{ color: MUTED, lineHeight: 1.5 }}>
          {targetIds.length} records are selected. Each enrichment run spends
          part of this workspace’s monthly allowance, so Greenlight will not
          start dozens of them from one click. Leads are enriched automatically
          as they are scored.
        </span>
      </div>
    );
  }

  const enrichment = response?.enrichment ?? null;
  const fields = Object.entries(enrichment?.fields ?? {});
  const quarantined = (enrichment?.sources ?? []).filter(
    (source) => source.quarantined === true,
  );

  const submit = async () => {
    if (submitting) {
      return;
    }

    setSubmitting(true);

    try {
      const result = await new RestApiClient().post<EnrichResponse>(
        ENRICH_LEAD_REQUEST_CLIENT_PATH,
        { leadRecordId: targetIds[0] },
      );

      setResponse(result ?? null);

      enqueueSnackbar({
        message: result?.message ?? 'Enrichment finished.',
        variant:
          result?.status === 'enriched'
            ? 'success'
            : result?.ok === false
              ? 'error'
              : 'info',
      });
    } catch (error) {
      enqueueSnackbar({
        message: `Not enriched. ${serverMessage(error)}`,
        variant: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={PANEL_STYLE}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <strong style={{ fontSize: '15px' }}>Greenlight enrichment</strong>
        <span style={{ color: MUTED, lineHeight: 1.5 }}>
          Looks up firmographic details on the public web and records each one
          with the page it came from. It never changes a field your team has
          filled in, and it never blocks the lead.
        </span>
      </div>

      <button
        type="button"
        disabled={submitting}
        onClick={submit}
        style={{
          padding: '10px 16px',
          borderRadius: '8px',
          border: '1px solid #e0e0e0',
          background: submitting ? '#f5f5f5' : ACCENT,
          color: submitting ? '#aaa' : '#fff',
          fontWeight: 600,
          cursor: submitting ? 'not-allowed' : 'pointer',
        }}
      >
        {submitting ? 'Looking…' : 'Enrich now'}
      </button>

      {response === null ? null : (
        <span
          style={{
            color: response.ok === false ? WARN : MUTED,
            lineHeight: 1.5,
          }}
        >
          {response.message}
        </span>
      )}

      {fields.length === 0 ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <span style={{ fontWeight: 600 }}>
            Sourced from the web{' '}
            <span style={{ color: MUTED, fontWeight: 400 }}>
              · not entered by your team
            </span>
          </span>
          {fields.map(([key, provenance]) => (
            <FieldCard key={key} fieldKey={key} provenance={provenance} />
          ))}
        </div>
      )}

      {quarantined.length === 0 ? null : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '12px',
            borderRadius: '8px',
            border: `1px solid ${WARN}33`,
            background: `${WARN}0A`,
          }}
        >
          <span style={{ fontWeight: 600, color: WARN }}>
            {quarantined.length} page{quarantined.length === 1 ? '' : 's'} ignored
          </span>
          <span style={{ color: MUTED, lineHeight: 1.5 }}>
            These search results contained text written to instruct an AI model
            rather than information about the company, so Greenlight refused to
            read them. Nothing from them was used.
          </span>
          <ul style={{ margin: 0, paddingLeft: '18px', color: MUTED }}>
            {quarantined.map((source, index) => (
              <li key={`${asText(source.url)}-${index}`}>
                {hostOf(asText(source.url))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: ENRICH_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-enrich-lead',
  description:
    'Side panel that runs Greenlight enrichment on one lead and shows each sourced value with its page, date and confidence.',
  component: GreenlightEnrichLead,
});
