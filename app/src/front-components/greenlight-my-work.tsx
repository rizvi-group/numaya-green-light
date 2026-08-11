import { useCallback, useEffect, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { defineFrontComponent } from 'twenty-sdk/define';
import { enqueueSnackbar } from 'twenty-sdk/front-component';

import {
  STAFF_SELF_SERVICE_CLIENT_PATH,
  STAFF_SELF_SERVICE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  WORKING_DAYS,
} from 'src/constants/sales-team-identifiers';
import type { SelfServiceView } from 'src/sales-team/self-service';

/**
 * "My work preferences" — a team member's own record, and nobody else's.
 *
 * The panel is deliberately thin: it renders what the route returns and posts
 * back a patch. It contains no notion of who the caller is, no record id it
 * chose, and no filter it could get wrong — those all live server-side, where a
 * client cannot argue with them. See `staff-self-service.logic-function.ts`.
 *
 * Hours are shown with the time zone beside them, always. "09:00–17:00" without
 * a zone is a different fact to every reader, and a manager in another country
 * is exactly who ends up misreading it.
 */

const GO = '#1F8A4C';
const MUTED = '#888';
const STOP = '#B42318';

const serverMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0
    ? error.message
    : 'Could not reach your team record.';

const CONTACT_MODES = ['EMAIL', 'PHONE', 'SLACK', 'TEAMS', 'IN_PERSON'] as const;
const OUT_OF_HOURS = ['NEVER', 'URGENT_ONLY', 'ANY_TIME'] as const;

const label = (value: string): string =>
  value === '' ? '—' : value.replace(/_/g, ' ').toLowerCase();

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <span style={{ fontSize: '12px', fontWeight: 600, color: MUTED }}>
      {title}
    </span>
    {children}
  </div>
);

const Field = ({
  label: text,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
    <span style={{ fontSize: '11px', color: MUTED }}>{text}</span>
    {children}
  </label>
);

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #e0e0e0',
  borderRadius: '4px',
  fontSize: '12px',
};

const GreenlightMyWork = () => {
  const [view, setView] = useState<SelfServiceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const mounted = useRef(true);

  const post = useCallback(async (body: Record<string, unknown>) => {
    try {
      const response = await new RestApiClient().post<SelfServiceView>(
        STAFF_SELF_SERVICE_CLIENT_PATH,
        body,
      );

      if (mounted.current && response) {
        setView(response);
        setDraft({});
      }

      return response ?? null;
    } catch (error) {
      if (mounted.current) {
        enqueueSnackbar({ message: serverMessage(error), variant: 'error' });
      }

      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void post({ action: 'status' }).finally(() => {
      if (mounted.current) {
        setLoading(false);
      }
    });

    return () => {
      mounted.current = false;
    };
  }, [post]);

  const save = useCallback(async () => {
    if (Object.keys(draft).length === 0) {
      return;
    }

    setSaving(true);
    const result = await post({ action: 'update', patch: draft });
    setSaving(false);

    if (result !== null) {
      enqueueSnackbar({ message: 'Saved.', variant: 'success' });
    }
  }, [draft, post]);

  if (loading) {
    return <div style={{ padding: '16px', color: MUTED }}>Loading…</div>;
  }

  if (view === null) {
    return (
      <div style={{ padding: '16px', color: STOP }}>
        Could not reach your team record.
      </div>
    );
  }

  if (view.outcome === 'no_record' || view.staff === null) {
    return (
      <div style={{ padding: '16px', fontSize: '12px', lineHeight: 1.6 }}>
        {view.message}
      </div>
    );
  }

  const staff = view.staff;
  const value = <K extends keyof typeof staff>(key: K) =>
    (key in draft ? draft[key as string] : staff[key]) as (typeof staff)[K];

  const set = (key: string, next: unknown) =>
    setDraft((current) => ({ ...current, [key]: next }));

  return (
    <div
      style={{
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
      }}
    >
      <div>
        <h3 style={{ margin: '0 0 4px', fontSize: '14px' }}>{staff.name}</h3>
        <span style={{ fontSize: '11px', color: MUTED }}>
          {label(staff.teamRole)} · {label(staff.seniority)} ·{' '}
          {label(staff.employmentStatus)}
        </span>
      </div>

      <Section title="WHEN YOU WORK">
        <Field label="Time zone">
          <input
            style={inputStyle}
            value={String(value('timeZone') ?? '')}
            placeholder="Australia/Sydney"
            onChange={(event) => set('timeZone', event.target.value)}
          />
        </Field>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Field label="From">
            <input
              style={inputStyle}
              value={String(value('preferredHoursFrom') ?? '')}
              placeholder="09:00"
              onChange={(event) => set('preferredHoursFrom', event.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              style={inputStyle}
              value={String(value('preferredHoursTo') ?? '')}
              placeholder="17:00"
              onChange={(event) => set('preferredHoursTo', event.target.value)}
            />
          </Field>
        </div>
        <span style={{ fontSize: '11px', color: MUTED }}>
          Local to your own time zone — anyone reading this elsewhere sees the
          zone beside the hours.
        </span>

        <Field label="Working days">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {WORKING_DAYS.map((day) => {
              const days = (value('workingDays') ?? []) as readonly string[];
              const on = days.includes(day);

              return (
                <button
                  key={day}
                  type="button"
                  onClick={() =>
                    set(
                      'workingDays',
                      on ? days.filter((d) => d !== day) : [...days, day],
                    )
                  }
                  style={{
                    ...inputStyle,
                    cursor: 'pointer',
                    background: on ? GO : '#fff',
                    color: on ? '#fff' : '#333',
                    borderColor: on ? GO : '#e0e0e0',
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </Field>
      </Section>

      <Section title="HOW TO REACH YOU">
        <Field label="Preferred contact">
          <select
            style={inputStyle}
            value={String(value('preferredContactMode') ?? 'EMAIL')}
            onChange={(event) => set('preferredContactMode', event.target.value)}
          >
            {CONTACT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {label(mode)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Out of hours">
          <select
            style={inputStyle}
            value={String(value('outOfHoursContact') ?? 'NEVER')}
            onChange={(event) => set('outOfHoursContact', event.target.value)}
          >
            {OUT_OF_HOURS.map((mode) => (
              <option key={mode} value={mode}>
                {label(mode)}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="YOUR CAPACITY">
        <label
          style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' }}
        >
          <input
            type="checkbox"
            checked={value('acceptingNewLeads') === true}
            onChange={(event) => set('acceptingNewLeads', event.target.checked)}
          />
          Accepting new leads
        </label>
        <span style={{ fontSize: '11px', color: MUTED }}>
          Your capacity of {staff.maxActiveLeads ?? '—'} and your coverage are set
          by your manager. This switch is yours.
        </span>
      </Section>

      {view.availability.length > 0 && (
        <Section title="YOUR TIME AWAY">
          {view.availability.map((entry) => (
            <div key={entry.id} style={{ fontSize: '12px' }}>
              <strong>{entry.name || label(entry.kind)}</strong>
              <span style={{ color: MUTED }}>
                {' '}
                — {(entry.startsOn ?? '').slice(0, 10)} to{' '}
                {(entry.endsOn ?? '').slice(0, 10)}
              </span>
            </div>
          ))}
        </Section>
      )}

      {view.notes.length > 0 && (
        <Section title="NOTES ABOUT YOUR WORK">
          {view.notes.map((note) => (
            <div key={note.id} style={{ fontSize: '12px', lineHeight: 1.5 }}>
              <strong>{note.summary}</strong>
              <span style={{ color: MUTED }}> · {label(note.noteType)}</span>
              {note.body !== '' && <div>{note.body}</div>}
            </div>
          ))}
        </Section>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving || Object.keys(draft).length === 0}
        style={{
          padding: '10px 12px',
          borderRadius: '6px',
          border: 'none',
          background: Object.keys(draft).length === 0 ? '#e0e0e0' : GO,
          color: Object.keys(draft).length === 0 ? '#888' : '#fff',
          fontSize: '13px',
          fontWeight: 600,
          cursor: Object.keys(draft).length === 0 ? 'default' : 'pointer',
        }}
      >
        {saving ? 'Saving…' : 'Save my preferences'}
      </button>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: STAFF_SELF_SERVICE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-my-work',
  description:
    'Side panel where a team member reviews their own sales team record and maintains their working preferences.',
  component: GreenlightMyWork,
});
