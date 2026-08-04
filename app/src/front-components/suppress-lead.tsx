import { useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { defineFrontComponent } from 'twenty-sdk/define';
import {
  closeSidePanel,
  enqueueSnackbar,
  useRecordId,
  useSelectedRecordIds,
} from 'twenty-sdk/front-component';

import {
  SUPPRESS_LEAD_CLIENT_PATH,
  SUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';
import {
  MAX_SUPPRESSION_NOTE_LENGTH,
  SUPPRESSION_REASONS,
  type SuppressionReasonCode,
} from 'src/gate/suppression-decision';

/**
 * Add one person to the do-not-contact list, with a reason on record.
 *
 * The shape follows `release-lead.tsx` — a real side panel with a form rather
 * than a headless confirmation modal — because the reason is the whole point and
 * a yes/no modal cannot ask for one. What differs is the tone: this panel is
 * styled as a stop, in red, because a rep who opens it by accident should know
 * within half a second that this is not a routine action.
 *
 * Nothing here is trusted. The panel posts a record id and a reason code; the
 * logic function re-reads the lead, re-validates the reason against the same
 * closed list, and takes the reviewer's identity from the authenticated request.
 */

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

type Phase = 'form' | 'submitting' | 'done';

interface SuppressResponse {
  readonly outcome?: string;
  readonly changed?: boolean;
  readonly message?: string;
  readonly auditWritten?: boolean;
}

/**
 * `RestApiClient` throws on a non-2xx response, carrying the parsed body. The
 * server writes its refusals for a salesperson, so that sentence is what should
 * reach them rather than an HTTP status.
 */
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

const SuppressLead = () => {
  const recordId = useRecordId();
  const selectedRecordIds = useSelectedRecordIds();

  const targetIds =
    selectedRecordIds.length > 0
      ? selectedRecordIds
      : recordId === null
        ? []
        : [recordId];

  const [reasonCode, setReasonCode] = useState<SuppressionReasonCode | null>(
    null,
  );
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>('form');

  if (targetIds.length === 0) {
    return (
      <div style={PANEL_STYLE}>
        <strong>Nothing selected</strong>
        <span style={{ color: '#888' }}>
          Open a person, or select one in a list, then run Do not contact again.
        </span>
      </div>
    );
  }

  if (targetIds.length > 1) {
    return (
      <div style={PANEL_STYLE}>
        <strong>One person at a time</strong>
        <span style={{ color: '#888' }}>
          {targetIds.length} records are selected. Each block is recorded as an
          individual decision with its own reason, so Greenlight does not apply
          them in bulk. Import a suppression file instead if you have one.
        </span>
      </div>
    );
  }

  const submit = async () => {
    if (reasonCode === null) {
      return;
    }

    setPhase('submitting');

    try {
      const response = await new RestApiClient().post<SuppressResponse>(
        SUPPRESS_LEAD_CLIENT_PATH,
        {
          leadObjectNameSingular: 'person',
          recordId: targetIds[0],
          reasonCode,
          note,
        },
      );

      enqueueSnackbar({
        message: response?.message ?? 'Block processed.',
        variant: response?.changed === true ? 'success' : 'info',
      });

      setPhase('done');
      closeSidePanel();
    } catch (error) {
      // Leave the form open: a refusal is not a reason to lose what they typed.
      enqueueSnackbar({
        message: `Not blocked. ${serverMessage(error)}`,
        variant: 'error',
      });

      setPhase('form');
    }
  };

  const isSubmitting = phase === 'submitting';

  return (
    <div style={PANEL_STYLE}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <strong style={{ fontSize: '15px', color: STOP }}>
          Do not contact this person
        </strong>
        <span style={{ color: '#888', lineHeight: 1.5 }}>
          Adds them to Greenlight’s block list. The lead is re-scored, blocked
          from outreach, and cannot be released by hand afterwards — the only way
          back is to lift the block, which is also recorded.
        </span>
      </div>

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
          Why must we not contact them?
        </legend>

        {SUPPRESSION_REASONS.map((reason) => (
          <label
            key={reason.code}
            style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'flex-start',
              padding: '10px 12px',
              borderRadius: '8px',
              border: `1px solid ${reasonCode === reason.code ? STOP : '#e0e0e0'}`,
              background: reasonCode === reason.code ? `${STOP}14` : '#fff',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="greenlight-suppression-reason"
              value={reason.code}
              checked={reasonCode === reason.code}
              disabled={isSubmitting}
              onChange={() => setReasonCode(reason.code)}
              style={{ marginTop: '2px' }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontWeight: 500 }}>{reason.label}</span>
              <span style={{ color: '#888', fontSize: '12px' }}>
                {reason.hint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <span style={{ fontWeight: 600 }}>
          Where did this come from?{' '}
          <span style={{ color: '#888' }}>(optional)</span>
        </span>
        <textarea
          value={note}
          maxLength={MAX_SUPPRESSION_NOTE_LENGTH}
          rows={3}
          disabled={isSubmitting}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Replied to the March newsletter asking to be removed."
          style={{
            border: '1px solid #e0e0e0',
            borderRadius: '8px',
            padding: '8px 10px',
            font: 'inherit',
            resize: 'vertical',
          }}
        />
        <span style={{ color: '#aaa', fontSize: '12px' }}>
          Do not record anything about the person here that does not belong in a
          CRM column indefinitely.
        </span>
      </label>

      <button
        type="button"
        disabled={reasonCode === null || isSubmitting}
        onClick={submit}
        style={{
          padding: '10px 16px',
          borderRadius: '8px',
          border: '1px solid #e0e0e0',
          background: reasonCode === null ? '#f5f5f5' : STOP,
          color: reasonCode === null ? '#aaa' : '#fff',
          fontWeight: 600,
          cursor: reasonCode === null || isSubmitting ? 'not-allowed' : 'pointer',
        }}
      >
        {isSubmitting ? 'Blocking…' : 'Add to block list'}
      </button>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: SUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'suppress-lead',
  description:
    'Side panel for adding a person to the Greenlight do-not-contact list with a recorded reason.',
  component: SuppressLead,
});
