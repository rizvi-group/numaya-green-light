import {
  buildSelfServiceView,
  isValidLocalTime,
  isValidWorkingDay,
  partitionSelfEdit,
  SELF_EDITABLE_FIELDS,
  type SelfServiceAvailabilityEntry,
  type SelfServiceNote,
  type SelfServiceStaffRecord,
} from 'src/sales-team/self-service';
import { describe, expect, it } from 'vitest';

const staff: SelfServiceStaffRecord = {
  id: 'staff-1',
  name: 'Priya Raman',
  employmentStatus: 'ACTIVE',
  teamRole: 'SALES_REP',
  timeZone: 'Australia/Sydney',
  workingDays: ['MON', 'TUE', 'WED'],
  preferredHoursFrom: '09:00',
  preferredHoursTo: '17:00',
  preferredContactMode: 'EMAIL',
  preferredMeetingLength: 30,
  outOfHoursContact: 'NEVER',
  languages: ['English', 'Tamil'],
  coverageRegions: ['Australia'],
  industryExpertise: ['Professional Services'],
  productLines: ['Core'],
  certifications: [],
  seniority: 'SENIOR',
  maxActiveLeads: 25,
  acceptingNewLeads: true,
};

const availability: SelfServiceAvailabilityEntry[] = [
  {
    id: 'a-1',
    name: 'Annual leave',
    kind: 'LEAVE',
    startsOn: '2026-09-01T00:00:00.000Z',
    endsOn: '2026-09-14T00:00:00.000Z',
    note: '',
  },
];

const notes: SelfServiceNote[] = [
  {
    id: 'n-1',
    summary: 'Cleared to sell the new line',
    body: 'Completed enablement.',
    noteType: 'CAPABILITY',
    occurredOn: '2026-08-01T00:00:00.000Z',
  },
];

describe('buildSelfServiceView', () => {
  it('should return the record, availability and notes when one is linked', () => {
    const view = buildSelfServiceView({ staff, availability, notes });

    expect(view.outcome).toBe('ok');
    expect(view.staff?.name).toBe('Priya Raman');
    expect(view.availability).toHaveLength(1);
    expect(view.notes).toHaveLength(1);
    expect(view.editableFields).toEqual(SELF_EDITABLE_FIELDS);
  });

  it('should say plainly when no record is linked, rather than showing an empty form', () => {
    const view = buildSelfServiceView({ staff: null, availability: [], notes: [] });

    expect(view.outcome).toBe('no_record');
    expect(view.message).toMatch(/no sales team record/i);
    expect(view.editableFields).toEqual([]);
  });

  /**
   * The disclosure this module exists to prevent. If the caller has no record,
   * any rows that reached the function belong to somebody else — returning them
   * would hand one rep another rep's notes.
   */
  it('should discard rows that arrive when the caller has no record of their own', () => {
    const view = buildSelfServiceView({ staff: null, availability, notes });

    expect(view.availability).toEqual([]);
    expect(view.notes).toEqual([]);
  });

  it('should never carry compensation, whatever it is handed', () => {
    const view = buildSelfServiceView({ staff, availability, notes });
    const serialised = JSON.stringify(view).toLowerCase();

    expect(serialised).not.toContain('compensation');
    expect(serialised).not.toContain('salary');
  });
});

describe('partitionSelfEdit', () => {
  it('should accept the preference fields a person knows better than their manager', () => {
    const { accepted, rejected } = partitionSelfEdit({
      timeZone: 'Australia/Perth',
      languages: ['English'],
      acceptingNewLeads: false,
    });

    expect(accepted).toEqual({
      timeZone: 'Australia/Perth',
      languages: ['English'],
      acceptingNewLeads: false,
    });
    expect(rejected).toEqual([]);
  });

  /**
   * Everything here is a decision a manager makes. A rep who could set their own
   * `teamRole` or `maxActiveLeads` would be editing the inputs to how work is
   * shared out, which is the manager's call and not theirs.
   */
  it('should refuse fields that belong to the manager', () => {
    const { accepted, rejected } = partitionSelfEdit({
      timeZone: 'Australia/Perth',
      teamRole: 'SALES_MANAGER',
      employmentStatus: 'ACTIVE',
      manager: 'someone-else',
      maxActiveLeads: 9999,
      seniority: 'PRINCIPAL',
    });

    expect(Object.keys(accepted)).toEqual(['timeZone']);
    expect(rejected).toEqual([
      'teamRole',
      'employmentStatus',
      'manager',
      'maxActiveLeads',
      'seniority',
    ]);
  });

  it('should refuse an attempt to reassign the record to another user', () => {
    const { accepted, rejected } = partitionSelfEdit({
      workspaceMember: 'another-member-id',
      id: 'another-staff-id',
    });

    expect(accepted).toEqual({});
    expect(rejected).toEqual(['workspaceMember', 'id']);
  });
});

describe('field validation', () => {
  it('should accept 24-hour local times and refuse anything else', () => {
    expect(isValidLocalTime('09:00')).toBe(true);
    expect(isValidLocalTime('23:59')).toBe(true);
    expect(isValidLocalTime('9:00')).toBe(false);
    expect(isValidLocalTime('24:00')).toBe(false);
    expect(isValidLocalTime('09:60')).toBe(false);
    expect(isValidLocalTime('2026-08-12T09:00:00Z')).toBe(false);
    expect(isValidLocalTime(900)).toBe(false);
  });

  it('should accept the seven day codes and refuse the rest', () => {
    expect(isValidWorkingDay('MON')).toBe(true);
    expect(isValidWorkingDay('SUN')).toBe(true);
    expect(isValidWorkingDay('Monday')).toBe(false);
    expect(isValidWorkingDay('mon')).toBe(false);
  });
});
