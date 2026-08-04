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
  RELEASE_LEAD_CLIENT_PATH,
  RELEASE_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';
import {
  MAX_REASON_NOTE_LENGTH,
  RELEASE_REASONS,
  type ReleaseReasonCode,
} from 'src/gate/release-decision';

/**
 * The override UI: pick a reason, release one lead.
 *
 * ## Why this is a panel and not a confirmation modal
 *
 * The SDK's `CommandModal` gives a headless yes/no confirmation, which would be
 * the cheaper build. It cannot ask for a reason, and the reason is the entire
 * Art. 22 argument — an override with nothing recorded about *why* is
 * indistinguishable from an automated release in the audit trail. So this is a
 * visible side-panel component with a real form.
 *
 * The reason is a required pick from a closed list with an optional note. The
 * reasoning for that shape is in `src/gate/release-decision.ts`; the short
 * version is that a mandatory free-text box collects the word "ok".
 *
 * ## Why one lead at a time
 *
 * The command is only offered when exactly one record is selected, and this
 * component refuses anything else. Bulk-releasing forty leads under a single
 * reason is precisely the "solely automated decision with a human rubber stamp"
 * shape that the override exists to avoid, and it would be the fastest way to
 * turn the audit trail into noise. The friction is the feature. If bulk release
 * is ever added it should record a distinct event type, not reuse this one.
 *
 * ## Trust boundary
 *
 * Nothing here is trusted. The panel sends a record id and a reason code; the
 * logic function re-reads the lead, re-checks that it is actually held, and
 * re-validates the reason. The identity of the reviewer is taken server-side
 * from the authenticated request, never from this component.
 */

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

interface ReleaseResponse {
  readonly outcome?: string;
  readonly released?: boolean;
  readonly message?: string;
  readonly auditWritten?: boolean;
}

/**
 * ## Why this panel now says the queue is stale instead of just closing
 *
 * The release clears the gate server-side, but the gate queue the reviewer is
 * looking at goes on listing the lead. That was measured against the running
 * instance rather than assumed, by releasing a lead and then counting the row:
 *
 *   no interaction at all ................ still there
 *   clicking the queue's own sidebar entry  still there
 *   navigating to another view and back ... still there
 *   a full document load ................. gone
 *
 * Only a full page load clears it. Twenty's record list is served from Apollo's
 * normalised cache, and in-app routing reads that cache rather than the server.
 *
 * An app cannot reach that cache. Everything a front component may ask the host
 * to do is the `FrontComponentHostCommunicationApi` surface exported by
 * `twenty-sdk/front-component` — navigate, openSidePanelPage, closeSidePanel,
 * openCommandConfirmationModal, enqueueSnackbar, unmountFrontComponent,
 * updateProgress, copyToClipboard, requestAccessTokenRefresh. There is no
 * refetch, no invalidate, and no query-client handle, and `navigate` is the
 * in-app routing that the measurement above shows does not refetch.
 *
 * Nor can it reload the page for the reviewer. A "Reload the page" button
 * calling `globalThis.location.reload()` was built and driven through the real
 * UI: it threw nothing, changed no URL, and left the released row exactly where
 * it was. The component runs against a partial DOM, not a browser page, and the
 * button was removed rather than shipped — a control that silently does nothing
 * is a worse lie than the stale list it was meant to fix.
 *
 * So the panel stops closing itself on success. It used to fire a toast and
 * vanish, which left a reviewer looking at a queue that still showed the lead
 * they had just released — the exact reading that gets a lead released twice.
 * It now stays open, says what happened, says plainly that the list behind it
 * is out of date, and says what the reviewer has to do about it. Telling the
 * truth is worth more here than a tidy dismissal.
 */

/**
 * `RestApiClient` throws `RestApiClientError` on a non-2xx response, carrying
 * the parsed body. The override answers refusals with a sentence written for a
 * salesperson, so that sentence is what should reach them.
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

const ReleaseLead = () => {
  const recordId = useRecordId();
  const selectedRecordIds = useSelectedRecordIds();

  const targetIds =
    selectedRecordIds.length > 0
      ? selectedRecordIds
      : recordId === null
        ? []
        : [recordId];

  const [reasonCode, setReasonCode] = useState<ReleaseReasonCode | null>(null);
  const [reasonNote, setReasonNote] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [outcome, setOutcome] = useState<{
    released: boolean;
    message: string;
  } | null>(null);

  if (targetIds.length === 0) {
    return (
      <div style={PANEL_STYLE}>
        <strong>Nothing selected</strong>
        <span style={{ color: '#888' }}>
          Open a lead, or select one in the gate queue, then run Release again.
        </span>
      </div>
    );
  }

  if (targetIds.length > 1) {
    return (
      <div style={PANEL_STYLE}>
        <strong>Release one lead at a time</strong>
        <span style={{ color: '#888' }}>
          {targetIds.length} leads are selected. Each release is recorded as an
          individual human decision, so Greenlight does not release them in bulk.
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
      const response = await new RestApiClient().post<ReleaseResponse>(
        RELEASE_LEAD_CLIENT_PATH,
        {
          leadObjectNameSingular: 'person',
          recordId: targetIds[0],
          reasonCode,
          reasonNote,
        },
      );

      enqueueSnackbar({
        message: response?.message ?? 'Release processed.',
        variant: response?.released === true ? 'success' : 'info',
      });

      setOutcome({
        released: response?.released === true,
        message: response?.message ?? 'Release processed.',
      });
      setPhase('done');
    } catch (error) {
      // The logic function refuses compliance blocks with a non-2xx status, so
      // this branch is a normal outcome, not only a transport failure. The
      // reviewer needs the server's explanation ("this contact has opted out"),
      // not the HTTP status, so the response body is preferred over the Error
      // message. Leave the form open — a refusal is not a reason to lose what
      // they typed.
      enqueueSnackbar({
        message: `Lead not released. ${serverMessage(error)}`,
        variant: 'error',
      });

      setPhase('form');
    }
  };

  const isSubmitting = phase === 'submitting';

  if (phase === 'done' && outcome !== null) {
    return (
      <div style={PANEL_STYLE}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <strong style={{ fontSize: '15px' }}>
            {outcome.released ? 'Lead released' : 'Nothing changed'}
          </strong>
          <span style={{ color: '#888', lineHeight: 1.5 }}>{outcome.message}</span>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '12px',
            borderRadius: '8px',
            border: '1px solid #e0e0e0',
            background: '#fafafa',
          }}
        >
          <strong>The queue behind this panel is out of date</strong>
          <span style={{ color: '#888', lineHeight: 1.5 }}>
            Twenty keeps the record list in the browser and gives an app no way
            to refresh it, so this lead is still listed as held even though the
            gate is now clear. Reload the page in your browser to see the queue
            as it really is — switching views will not do it.
          </span>
          <span style={{ color: '#888', lineHeight: 1.5 }}>
            Releasing it again from the stale row is safe: Greenlight refuses a
            second release and writes nothing twice.
          </span>
        </div>

        <button
          type="button"
          onClick={() => closeSidePanel()}
          style={{
            alignSelf: 'flex-start',
            padding: '8px 14px',
            borderRadius: '8px',
            border: '1px solid #e0e0e0',
            background: '#fff',
            color: '#333',
            cursor: 'pointer',
          }}
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div style={PANEL_STYLE}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <strong style={{ fontSize: '15px' }}>Release this lead</strong>
        <span style={{ color: '#888', lineHeight: 1.5 }}>
          Clears the Greenlight gate so the lead reaches a rep. Your reason is
          written to the Greenlight audit log and cannot be edited afterwards.
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
          Why are you releasing it?
        </legend>

        {RELEASE_REASONS.map((reason) => (
          <label
            key={reason.code}
            style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'flex-start',
              padding: '10px 12px',
              borderRadius: '8px',
              border: `1px solid ${reasonCode === reason.code ? '#73D08D' : '#e0e0e0'}`,
              background: reasonCode === reason.code ? '#73D08D14' : '#fff',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="greenlight-release-reason"
              value={reason.code}
              checked={reasonCode === reason.code}
              disabled={isSubmitting}
              onChange={() => setReasonCode(reason.code)}
              style={{ marginTop: '2px' }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontWeight: 500 }}>{reason.label}</span>
              <span style={{ color: '#888', fontSize: '12px' }}>{reason.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <span style={{ fontWeight: 600 }}>
          Anything to add? <span style={{ color: '#888' }}>(optional)</span>
        </span>
        <textarea
          value={reasonNote}
          maxLength={MAX_REASON_NOTE_LENGTH}
          rows={3}
          disabled={isSubmitting}
          onChange={(event) => setReasonNote(event.target.value)}
          placeholder="Context a colleague would need in six months."
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
          permanent log.
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
          background: reasonCode === null ? '#f5f5f5' : '#73D08D',
          color: reasonCode === null ? '#aaa' : '#fff',
          fontWeight: 600,
          cursor: reasonCode === null || isSubmitting ? 'not-allowed' : 'pointer',
        }}
      >
        {isSubmitting ? 'Releasing…' : 'Release lead'}
      </button>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: RELEASE_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'release-lead',
  description:
    'Side panel for releasing a lead held by the Greenlight gate, with a recorded override reason.',
  component: ReleaseLead,
});
