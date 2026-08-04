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
  UNSUPPRESS_LEAD_CLIENT_PATH,
  UNSUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';
import {
  MAX_SUPPRESSION_NOTE_LENGTH,
  MIN_UNSUPPRESSION_NOTE_LENGTH,
  UNSUPPRESSION_REASONS,
  type UnsuppressionReasonCode,
} from 'src/gate/suppression-decision';

/**
 * Lift a suppression — the more sensitive of the two block-list actions.
 *
 * Everything that makes this harder than its counterpart is enforced on the
 * server (`parseUnsuppressRequest`), not here. This panel's job is to make the
 * requirements visible *before* somebody types, so the friction reads as
 * deliberate rather than as a form that keeps rejecting them:
 *
 *   - a reason from a list whose every entry is a claim that the suppression was
 *     wrong or has been superseded;
 *   - a written note, minimum length shown live;
 *   - an explicit acknowledgement that contact is being re-enabled.
 *
 * The button stays disabled until all three are satisfied. That is a duplicate
 * of the server rules, and duplicating them is correct here: a disabled button
 * teaches, a 400 response scolds.
 */

const CAUTION = '#B54708';

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

interface UnsuppressResponse {
  readonly outcome?: string;
  readonly changed?: boolean;
  readonly message?: string;
  readonly auditWritten?: boolean;
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

const UnsuppressLead = () => {
  const recordId = useRecordId();
  const selectedRecordIds = useSelectedRecordIds();

  const targetIds =
    selectedRecordIds.length > 0
      ? selectedRecordIds
      : recordId === null
        ? []
        : [recordId];

  const [reasonCode, setReasonCode] = useState<UnsuppressionReasonCode | null>(
    null,
  );
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');

  if (targetIds.length === 0) {
    return (
      <div style={PANEL_STYLE}>
        <strong>Nothing selected</strong>
        <span style={{ color: '#888' }}>
          Open a person, or select one in the Do Not Contact list, then run Allow
          contact again.
        </span>
      </div>
    );
  }

  if (targetIds.length > 1) {
    return (
      <div style={PANEL_STYLE}>
        <strong>One person at a time</strong>
        <span style={{ color: '#888' }}>
          {targetIds.length} records are selected. Lifting a do-not-contact entry
          is an individual decision that has to be justified individually, so
          Greenlight never does it in bulk.
        </span>
      </div>
    );
  }

  const noteRemaining = MIN_UNSUPPRESSION_NOTE_LENGTH - note.trim().length;
  const canSubmit =
    reasonCode !== null && acknowledged && noteRemaining <= 0 && phase === 'form';

  const submit = async () => {
    if (!canSubmit) {
      return;
    }

    setPhase('submitting');

    try {
      const response = await new RestApiClient().post<UnsuppressResponse>(
        UNSUPPRESS_LEAD_CLIENT_PATH,
        {
          leadObjectNameSingular: 'person',
          recordId: targetIds[0],
          reasonCode,
          note,
          acknowledged: true,
        },
      );

      enqueueSnackbar({
        message: response?.message ?? 'Removal processed.',
        variant: response?.changed === true ? 'success' : 'info',
      });

      setPhase('done');
      closeSidePanel();
    } catch (error) {
      enqueueSnackbar({
        message: `Not removed. ${serverMessage(error)}`,
        variant: 'error',
      });

      setPhase('form');
    }
  };

  const isSubmitting = phase === 'submitting';

  return (
    <div style={PANEL_STYLE}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <strong style={{ fontSize: '15px', color: CAUTION }}>
          Allow contact again
        </strong>
        <span style={{ color: '#888', lineHeight: 1.5 }}>
          This removes the person from Greenlight’s block list and re-enables
          outreach to somebody who is on record asking us to stop. Your name, the
          reason, and what they were originally blocked for all go into the
          audit log and cannot be edited afterwards.
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
          Why should the block be lifted?
        </legend>

        {UNSUPPRESSION_REASONS.map((reason) => (
          <label
            key={reason.code}
            style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'flex-start',
              padding: '10px 12px',
              borderRadius: '8px',
              border: `1px solid ${
                reasonCode === reason.code ? CAUTION : '#e0e0e0'
              }`,
              background: reasonCode === reason.code ? `${CAUTION}14` : '#fff',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="greenlight-unsuppression-reason"
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
          What happened? <span style={{ color: CAUTION }}>(required)</span>
        </span>
        <textarea
          value={note}
          maxLength={MAX_SUPPRESSION_NOTE_LENGTH}
          rows={4}
          disabled={isSubmitting}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Where is the evidence that this block should not stand? A colleague reading this in a year must be able to tell."
          style={{
            border: '1px solid #e0e0e0',
            borderRadius: '8px',
            padding: '8px 10px',
            font: 'inherit',
            resize: 'vertical',
          }}
        />
        <span style={{ color: noteRemaining > 0 ? CAUTION : '#aaa', fontSize: '12px' }}>
          {noteRemaining > 0
            ? `${noteRemaining} more character${noteRemaining === 1 ? '' : 's'} needed.`
            : 'This is the only place the evidence for lifting the block will live.'}
        </span>
      </label>

      <label
        style={{
          display: 'flex',
          gap: '10px',
          alignItems: 'flex-start',
          padding: '10px 12px',
          borderRadius: '8px',
          border: `1px solid ${acknowledged ? CAUTION : '#e0e0e0'}`,
          background: acknowledged ? `${CAUTION}14` : '#fff',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={isSubmitting}
          onChange={(event) => setAcknowledged(event.target.checked)}
          style={{ marginTop: '2px' }}
        />
        <span>
          I understand this re-enables contact with this person, and I have a
          basis for doing so.
        </span>
      </label>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        style={{
          padding: '10px 16px',
          borderRadius: '8px',
          border: '1px solid #e0e0e0',
          background: canSubmit ? CAUTION : '#f5f5f5',
          color: canSubmit ? '#fff' : '#aaa',
          fontWeight: 600,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
        }}
      >
        {isSubmitting ? 'Removing…' : 'Remove from block list'}
      </button>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: UNSUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'unsuppress-lead',
  description:
    'Side panel for lifting a Greenlight do-not-contact suppression, with a mandatory reason, note and acknowledgement.',
  component: UnsuppressLead,
});
