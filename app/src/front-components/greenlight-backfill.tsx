import { useCallback, useEffect, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { defineFrontComponent } from 'twenty-sdk/define';
import { enqueueSnackbar } from 'twenty-sdk/front-component';

import {
  BACKFILL_CLIENT_PATH,
  BACKFILL_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/backfill-identifiers';
import { BACKFILL_MODE_LABELS } from 'src/backfill/backfill-command';
import { BACKFILL_MODES, type BackfillMode } from 'src/backfill/backfill-state';

/**
 * "Score existing leads" — the backfill's whole admin surface.
 *
 * ## Why this panel exists at all
 *
 * The defect being fixed is not "existing records are unscored". It is that
 * *nobody could tell*: 1200 of 1205 people unscored while the gate queue read
 * empty, which looks exactly like a gate that is working and finding nothing
 * wrong. A background job that silently fixes it would replace one invisible
 * state with another — "a backfill might be running, or might have died four
 * hours ago" is not better than "nothing is checking".
 *
 * So the panel leads with the number, not with the button. The first thing an
 * admin sees is how many people have never been scored, in plain words, before
 * any control. If that number is zero it says so, which is the only circumstance
 * in which an empty gate queue means what it appears to mean.
 *
 * ## Polling
 *
 * Every five seconds while the panel is open, and never otherwise. The run
 * advances in one-minute steps, so this is well inside "feels live" and costs two
 * cheap queries a poll. `useRef` holds the timer so a panel closed mid-flight
 * stops polling rather than leaking an interval that keeps hitting the route.
 *
 * ## Nothing here is trusted
 *
 * The panel posts an action and a mode; the logic function re-validates both
 * against closed lists and takes the requester's identity from the authenticated
 * request. The confirmation for the destructive mode is a client-side courtesy —
 * the server would run it either way, so the honesty is in the copy, not in the
 * guard.
 */

const GO = '#1F8A4C';
const WARN = '#B54708';
const STOP = '#B42318';

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

const POLL_INTERVAL_MS = 5_000;

interface BackfillRun {
  readonly runId: string;
  readonly mode: BackfillMode;
  readonly status: 'running' | 'completed' | 'cancelled' | 'failed';
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly totalAtStart: number | null;
  readonly examined: number;
  readonly scored: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly failed: number;
  readonly chunks: number;
  readonly lastError: string | null;
  readonly requestedBy: string;
  readonly percent: number | null;
  readonly minutesRemaining: number | null;
  readonly working: boolean;
}

interface BackfillResponse {
  readonly outcome?: string;
  readonly message?: string;
  readonly run?: BackfillRun | null;
  readonly neverScoredCount?: number | null;
  readonly chunkSize?: number;
}

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

/** Local time, because "when did it last finish" is a wall-clock question. */
const formatMoment = (iso: string | null): string => {
  if (iso === null) {
    return '—';
  }

  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
};

const STATUS_COPY: Record<BackfillRun['status'], { label: string; color: string }> =
  {
    running: { label: 'Running', color: GO },
    completed: { label: 'Finished', color: GO },
    cancelled: { label: 'Stopped by an admin', color: WARN },
    failed: { label: 'Failed', color: STOP },
  };

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
    <span style={{ color: '#888', fontSize: '12px' }}>{label}</span>
    <span style={{ fontWeight: 600 }}>{value}</span>
  </div>
);

const ProgressBar = ({ percent }: { percent: number | null }) => (
  <div
    style={{
      height: '8px',
      borderRadius: '4px',
      background: '#eee',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        height: '100%',
        width: percent === null ? '100%' : `${percent}%`,
        background: percent === null ? '#ddd' : GO,
        transition: 'width 0.4s',
      }}
    />
  </div>
);

const GreenlightBackfill = () => {
  const [state, setState] = useState<BackfillResponse | null>(null);
  const [mode, setMode] = useState<BackfillMode>('unscored');
  const [busy, setBusy] = useState(false);
  const [confirmRescoreAll, setConfirmRescoreAll] = useState(false);
  const mounted = useRef(true);

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<BackfillResponse | null> => {
      try {
        const response = await new RestApiClient().post<BackfillResponse>(
          BACKFILL_CLIENT_PATH,
          body,
        );

        if (mounted.current) {
          setState(response ?? null);
        }

        return response ?? null;
      } catch (error) {
        if (mounted.current) {
          enqueueSnackbar({
            message: serverMessage(error),
            variant: 'error',
          });
        }

        return null;
      }
    },
    [],
  );

  useEffect(() => {
    mounted.current = true;

    void post({ action: 'status' });

    const timer = setInterval(() => {
      void post({ action: 'status' });
    }, POLL_INTERVAL_MS);

    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [post]);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);

    const response = await post(body);

    if (response?.message !== undefined && response.message !== '') {
      enqueueSnackbar({ message: response.message, variant: 'info' });
    }

    setBusy(false);
    setConfirmRescoreAll(false);
  };

  const run = state?.run ?? null;
  const neverScored = state?.neverScoredCount ?? null;
  const chunkSize = state?.chunkSize ?? null;
  const isRunning = run !== null && run.status === 'running';

  return (
    <div style={PANEL_STYLE}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <strong style={{ fontSize: '15px' }}>Score existing leads</strong>
        <span style={{ color: '#888', lineHeight: 1.5 }}>
          Greenlight scores a lead when it is created or changed. Anyone already
          in the CRM when it was installed has never been through the gate.
        </span>
      </div>

      <div
        style={{
          padding: '14px 16px',
          borderRadius: '10px',
          border: `1px solid ${neverScored === 0 ? `${GO}55` : '#e0e0e0'}`,
          background: neverScored === 0 ? `${GO}0F` : '#fafafa',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}
      >
        {state === null ? (
          <span style={{ color: '#888' }}>Checking…</span>
        ) : neverScored === null ? (
          <span style={{ color: '#888' }}>
            Greenlight could not count the leads on this workspace just now.
          </span>
        ) : neverScored === 0 ? (
          <>
            <strong style={{ color: GO, fontSize: '15px' }}>
              Every lead has been scored
            </strong>
            <span style={{ color: '#888' }}>
              An empty gate queue means what it looks like it means.
            </span>
          </>
        ) : (
          <>
            <strong style={{ color: WARN, fontSize: '15px' }}>
              {neverScored.toLocaleString()} leads have never been scored
            </strong>
            <span style={{ color: '#888', lineHeight: 1.5 }}>
              They are not in the gate queue because nothing has looked at them.
              Until they are scored, an empty queue is not evidence that they are
              clean.
            </span>
          </>
        )}
      </div>

      {run !== null && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            padding: '14px 16px',
            borderRadius: '10px',
            border: '1px solid #e0e0e0',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: '8px',
            }}
          >
            <strong style={{ color: STATUS_COPY[run.status].color }}>
              {STATUS_COPY[run.status].label}
              {run.working ? ' · working now' : ''}
            </strong>
            <span style={{ color: '#888', fontSize: '12px' }}>
              {BACKFILL_MODE_LABELS[run.mode].label}
            </span>
          </div>

          <ProgressBar percent={run.percent} />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
              gap: '12px',
            }}
          >
            <Stat
              label="Examined"
              value={
                run.totalAtStart === null
                  ? run.examined.toLocaleString()
                  : `${run.examined.toLocaleString()} / ${run.totalAtStart.toLocaleString()}`
              }
            />
            <Stat label="Scored" value={run.scored.toLocaleString()} />
            <Stat
              label="Already current"
              value={run.unchanged.toLocaleString()}
            />
            <Stat label="Failed open" value={run.failed.toLocaleString()} />
          </div>

          <div style={{ color: '#888', fontSize: '12px', lineHeight: 1.6 }}>
            <div>Started {formatMoment(run.startedAt)}</div>
            <div>
              {run.status === 'running'
                ? `Last progress ${formatMoment(run.updatedAt)}${
                    run.minutesRemaining === null
                      ? ''
                      : ` · about ${run.minutesRemaining} min left`
                  }`
                : `Finished ${formatMoment(run.finishedAt)}`}
            </div>
            <div>Requested by {run.requestedBy}</div>
          </div>

          {run.lastError !== null && (
            <span style={{ color: WARN, fontSize: '12px', lineHeight: 1.5 }}>
              Last problem: {run.lastError}
            </span>
          )}
        </div>
      )}

      {isRunning ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act({ action: 'stop' })}
          style={{
            padding: '10px 16px',
            borderRadius: '8px',
            border: '1px solid #e0e0e0',
            background: '#fff',
            color: STOP,
            fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'Stopping…' : 'Stop the backfill'}
        </button>
      ) : (
        <>
          <fieldset
            style={{
              border: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <legend style={{ padding: 0, fontWeight: 600, marginBottom: '4px' }}>
              What should it score?
            </legend>

            {BACKFILL_MODES.map((candidate) => (
              <label
                key={candidate}
                style={{
                  display: 'flex',
                  gap: '10px',
                  alignItems: 'flex-start',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: `1px solid ${mode === candidate ? '#999' : '#e0e0e0'}`,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="greenlight-backfill-mode"
                  value={candidate}
                  checked={mode === candidate}
                  disabled={busy}
                  onChange={() => {
                    setMode(candidate);
                    setConfirmRescoreAll(false);
                  }}
                  style={{ marginTop: '2px' }}
                />
                <span
                  style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}
                >
                  <span style={{ fontWeight: 500 }}>
                    {BACKFILL_MODE_LABELS[candidate].label}
                  </span>
                  <span style={{ color: '#888', fontSize: '12px' }}>
                    {BACKFILL_MODE_LABELS[candidate].hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {mode === 'all' && (
            <label
              style={{
                display: 'flex',
                gap: '10px',
                alignItems: 'flex-start',
                color: WARN,
                lineHeight: 1.5,
              }}
            >
              <input
                type="checkbox"
                checked={confirmRescoreAll}
                disabled={busy}
                onChange={(event) => setConfirmRescoreAll(event.target.checked)}
                style={{ marginTop: '2px' }}
              />
              <span>
                I understand this rewrites the decision on every lead. Leads a
                colleague released by hand stay released — Greenlight honours
                those — but everything else is judged again against the current
                rules.
              </span>
            </label>
          )}

          <button
            type="button"
            disabled={busy || (mode === 'all' && !confirmRescoreAll)}
            onClick={() => void act({ action: 'start', mode })}
            style={{
              padding: '10px 16px',
              borderRadius: '8px',
              border: '1px solid #e0e0e0',
              background:
                busy || (mode === 'all' && !confirmRescoreAll) ? '#f5f5f5' : GO,
              color:
                busy || (mode === 'all' && !confirmRescoreAll) ? '#aaa' : '#fff',
              fontWeight: 600,
              cursor:
                busy || (mode === 'all' && !confirmRescoreAll)
                  ? 'not-allowed'
                  : 'pointer',
            }}
          >
            {busy ? 'Starting…' : 'Start backfill'}
          </button>
        </>
      )}

      <span style={{ color: '#aaa', fontSize: '12px', lineHeight: 1.5 }}>
        {chunkSize === null
          ? 'The backfill runs in the background in small batches so it never uses up the API allowance new leads need.'
          : `The backfill runs in the background at about ${chunkSize} leads a minute, so it never uses up the API allowance new leads need. It picks up where it left off if it is interrupted, and re-running it never scores the same lead twice.`}
      </span>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: BACKFILL_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-backfill',
  description:
    'Side panel showing how many leads have never been scored, and starting or stopping the Greenlight backfill.',
  component: GreenlightBackfill,
});
