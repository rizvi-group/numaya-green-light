import { describe, expect, it } from 'vitest';

import { formatActor, readActorIdentityFrom } from 'src/identity/actor';

const UWID = '20202020-9e3b-46d4-a556-88b9ddc2b035';
const MEMBER_ID = '20202020-0687-4c41-b707-ed1bfca972a7';

const currentUser = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  currentUser: {
    currentUserWorkspace: { id: UWID },
    workspaceMember: {
      id: MEMBER_ID,
      name: { firstName: 'Priya', lastName: 'Raman' },
      userEmail: 'priya@northwind.example',
    },
    ...overrides,
  },
});

describe('readActorIdentityFrom', () => {
  it('reads the name and the durable member id', () => {
    expect(readActorIdentityFrom(currentUser(), UWID)).toEqual({
      workspaceMemberId: MEMBER_ID,
      displayName: 'Priya Raman',
    });
  });

  it('refuses an identity belonging to a different request', () => {
    // The security property: the actor must be the human this request
    // authenticated as, never an ambient identity the runtime had to hand.
    expect(
      readActorIdentityFrom(currentUser(), 'a-different-user-workspace'),
    ).toBeNull();
  });

  it('refuses when the request carries no user-workspace id at all', () => {
    expect(readActorIdentityFrom(currentUser(), '')).toBeNull();
  });

  it('falls back to the address when the directory has no name', () => {
    const payload = currentUser({
      workspaceMember: {
        id: MEMBER_ID,
        name: { firstName: '', lastName: '' },
        userEmail: 'priya@northwind.example',
      },
    });

    expect(readActorIdentityFrom(payload, UWID)).toEqual({
      workspaceMemberId: MEMBER_ID,
      displayName: 'priya@northwind.example',
    });
  });

  it('keeps a single-name member readable, with no trailing space', () => {
    const payload = currentUser({
      workspaceMember: {
        id: MEMBER_ID,
        name: { firstName: 'Priya', lastName: '' },
        userEmail: '',
      },
    });

    expect(readActorIdentityFrom(payload, UWID)?.displayName).toBe('Priya');
  });

  it('returns null rather than an unnamed identity', () => {
    const payload = currentUser({
      workspaceMember: { id: MEMBER_ID, name: {}, userEmail: '' },
    });

    expect(readActorIdentityFrom(payload, UWID)).toBeNull();
  });

  it('returns null rather than a nameless id', () => {
    const payload = currentUser({
      workspaceMember: {
        id: '',
        name: { firstName: 'Priya', lastName: 'Raman' },
      },
    });

    expect(readActorIdentityFrom(payload, UWID)).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'currentUser'],
    ['an array', []],
    ['an empty object', {}],
    ['a currentUser with no member', { currentUser: {} }],
    [
      'a currentUser with no user-workspace',
      { currentUser: { workspaceMember: { id: MEMBER_ID } } },
    ],
  ])('degrades to null on %s rather than throwing', (_label, payload) => {
    expect(() => readActorIdentityFrom(payload, UWID)).not.toThrow();
    expect(readActorIdentityFrom(payload, UWID)).toBeNull();
  });
});

describe('formatActor', () => {
  it('names the person and keeps the account traceable', () => {
    expect(
      formatActor(
        { workspaceMemberId: MEMBER_ID, displayName: 'Priya Raman' },
        UWID,
      ),
    ).toBe(`Priya Raman (workspace member ${MEMBER_ID})`);
  });

  it('keeps the whole id, because a truncated one cannot be searched for', () => {
    const actor = formatActor(
      { workspaceMemberId: MEMBER_ID, displayName: 'Priya Raman' },
      UWID,
    );

    expect(actor).toContain(MEMBER_ID);
  });

  it('falls back to the id-bearing string this app already wrote', () => {
    // Byte-for-byte the pre-existing behaviour: a failed lookup must put the
    // audit trail back where it was, not somewhere new.
    expect(formatActor(null, UWID)).toBe(`Workspace member ${UWID}`);
  });

  it.each([null, undefined, ''])(
    'says so plainly when the request identified nobody (%s)',
    (userWorkspaceId) => {
      expect(formatActor(null, userWorkspaceId)).toBe(
        'Unidentified workspace member',
      );
    },
  );

  it('never returns an empty actor', () => {
    expect(formatActor(null, null)).not.toBe('');
    expect(formatActor(null, UWID)).not.toBe('');
  });
});
