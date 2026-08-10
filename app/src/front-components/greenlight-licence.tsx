import { useCallback, useEffect, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { defineFrontComponent } from 'twenty-sdk/define';
import { enqueueSnackbar } from 'twenty-sdk/front-component';

import {
  LICENCE_CLIENT_PATH,
  LICENCE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/licence-identifiers';
import type { LicencePanelView } from 'src/licensing/panel';

/**
 * "Greenlight licence" — what you are running, and how to buy what you are not.
 *
 * ## Why this panel exists
 *
 * Until it did, a workspace in rules-only mode had no way to find that out from
 * the UI, and no way to act on it. The state was real and correctly computed —
 * the nightly run publishes it and every enrichment decision reads it — but the
 * only places it surfaced were audit rows and a mode word inside a trace. An
 * admin wondering "why is nothing being enriched" had to be told the answer by
 * a human, and an admin who wanted to fix it had nowhere to go: `LICENCE_KEY`
 * is a settings field that presumes you already hold a key.
 *
 * So this panel states the mode in a sentence, names enrichment as the thing a
 * licence buys, and — only in the two states a purchase would actually fix —
 * offers the route to obtain one.
 *
 * ## Why the button is a link and not a checkout
 *
 * There is no self-serve purchase yet: no Greenlight pricing page, no payment
 * step, and no marketplace billing rail to inherit one from. A button that
 * opened a fake checkout would be worse than a link to a human who can issue a
 * key. When a real purchase page exists, `LICENCE_PURCHASE_URL` is the only
 * line that changes and this component does not notice.
 */

const GO = '#1F8A4C';
const WARN = '#B54708';
const STOP = '#B42318';
const MUTED = '#888';

const SEVERITY_COLOR: Record<LicencePanelView['severity'], string> = {
  ok: GO,
  notice: MUTED,
  warning: WARN,
  problem: STOP,
};

const serverMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0
    ? error.message
    : 'Could not read the licence status.';

/**
 * "6 hours ago" beats an ISO timestamp for the one question this line answers:
 * is what I am reading current. Anything older than a day is shown in days,
 * because at that point the nightly run has missed and the number of hours
 * stops being the interesting part.
 */
const describeAge = (checkedAt: string | null, now: Date): string => {
  if (checkedAt === null) {
    return 'never';
  }

  const checked = Date.parse(checkedAt);

  if (Number.isNaN(checked)) {
    return 'unknown';
  }

  const minutes = Math.max(0, Math.floor((now.getTime() - checked) / 60_000));

  if (minutes < 60) {
    return minutes <= 1 ? 'just now' : `${minutes} minutes ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }

  const days = Math.floor(hours / 24);

  return days === 1 ? '1 day ago' : `${days} days ago`;
};

const Row = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
    <span style={{ color: MUTED, fontSize: '12px' }}>{label}</span>
    <span style={{ fontSize: '12px', textAlign: 'right' }}>{value}</span>
  </div>
);

const GreenlightLicence = () => {
  const [view, setView] = useState<LicencePanelView | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await new RestApiClient().post<LicencePanelView>(
        LICENCE_CLIENT_PATH,
        {},
      );

      if (mounted.current) {
        setView(response ?? null);
      }
    } catch (error) {
      if (mounted.current) {
        enqueueSnackbar({ message: serverMessage(error), variant: 'error' });
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();

    return () => {
      mounted.current = false;
    };
  }, [load]);

  if (loading) {
    return <div style={{ padding: '16px', color: MUTED }}>Checking…</div>;
  }

  if (view === null) {
    return (
      <div style={{ padding: '16px', color: STOP }}>
        Could not read the licence status. Scoring and the gate are unaffected.
      </div>
    );
  }

  const now = new Date();

  return (
    <div
      style={{
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      <div>
        <h3 style={{ margin: '0 0 4px', fontSize: '14px' }}>Greenlight licence</h3>
        <span style={{ color: MUTED, fontSize: '12px' }}>
          A licence buys AI and search enrichment. Scoring, the gate and the queue
          run without one and are never affected by it.
        </span>
      </div>

      <div
        style={{
          border: `1px solid ${SEVERITY_COLOR[view.severity]}22`,
          background: `${SEVERITY_COLOR[view.severity]}0D`,
          borderRadius: '6px',
          padding: '12px',
        }}
      >
        <div
          style={{
            color: SEVERITY_COLOR[view.severity],
            fontWeight: 600,
            fontSize: '13px',
            marginBottom: '4px',
          }}
        >
          {view.headline}
        </div>
        <div style={{ fontSize: '12px', lineHeight: 1.5 }}>{view.detail}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <Row
          label="Enrichment"
          value={view.enrichmentEnabled ? 'Enabled' : 'Off'}
        />
        <Row label="Mode" value={view.mode} />
        <Row
          label="Licence key"
          value={view.maskedKey.length === 0 ? 'Set, not yet checked' : view.maskedKey}
        />
        {view.environment !== null && (
          <Row label="Environment" value={view.environment} />
        )}
        <Row label="Last checked" value={describeAge(view.checkedAt, now)} />
      </div>

      {view.callToAction !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <a
            href={view.callToAction.url}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              display: 'block',
              textAlign: 'center',
              padding: '10px 12px',
              borderRadius: '6px',
              background: GO,
              color: '#fff',
              fontSize: '13px',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {view.callToAction.label}
          </a>
          <span style={{ color: MUTED, fontSize: '11px', lineHeight: 1.5 }}>
            Opens numaya.ai in a new tab. Once you have a key, paste it into
            LICENCE_KEY under Settings → Apps → Numaya Greenlight; the next check
            picks it up.
          </span>
        </div>
      )}
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: LICENCE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-licence',
  description:
    'Side panel showing the Greenlight licence mode, whether enrichment is enabled, and where to obtain a licence.',
  component: GreenlightLicence,
});
