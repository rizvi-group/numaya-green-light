import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ActorIdentity } from 'src/identity/actor';
import {
  clearActorCache,
  resolveActorDisplayName,
  type ActorIdentityPort,
} from 'src/logic-functions/actor-identity';

const UWID = '20202020-9e3b-46d4-a556-88b9ddc2b035';
const OTHER_UWID = '31313131-0007-4000-8000-000000000000';
const MEMBER_ID = '20202020-0687-4c41-b707-ed1bfca972a7';

const identity: ActorIdentity = {
  workspaceMemberId: MEMBER_ID,
  displayName: 'Priya Raman',
};

const portReturning = (
  answer: ActorIdentity | null,
): ActorIdentityPort & { read: ReturnType<typeof vi.fn> } => ({
  read: vi.fn(async () => answer),
});

beforeEach(() => {
  clearActorCache();
});

describe('resolveActorDisplayName', () => {
  it('names the person making the request', async () => {
    const port = portReturning(identity);

    await expect(
      resolveActorDisplayName({ userWorkspaceId: UWID }, port),
    ).resolves.toBe(`Priya Raman (workspace member ${MEMBER_ID})`);

    expect(port.read).toHaveBeenCalledWith(UWID);
  });

  it('resolves once and reuses the answer — a backfill writes thousands of rows', async () => {
    const port = portReturning(identity);

    for (let index = 0; index < 2_000; index += 1) {
      await resolveActorDisplayName({ userWorkspaceId: UWID }, port);
    }

    expect(port.read).toHaveBeenCalledTimes(1);
  });

  it('never lets two people share one cached answer', async () => {
    const port: ActorIdentityPort = {
      read: vi.fn(async (userWorkspaceId: string) =>
        userWorkspaceId === UWID
          ? identity
          : { workspaceMemberId: 'other-member', displayName: 'Sam Okafor' },
      ),
    };

    const first = await resolveActorDisplayName({ userWorkspaceId: UWID }, port);
    const second = await resolveActorDisplayName(
      { userWorkspaceId: OTHER_UWID },
      port,
    );

    expect(first).toContain('Priya Raman');
    expect(second).toContain('Sam Okafor');
  });

  it('falls back to the id-bearing string when the name cannot be resolved', async () => {
    await expect(
      resolveActorDisplayName({ userWorkspaceId: UWID }, portReturning(null)),
    ).resolves.toBe(`Workspace member ${UWID}`);
  });

  it('does not cache a failure — the next request tries again', async () => {
    let answer: ActorIdentity | null = null;
    const port: ActorIdentityPort = { read: vi.fn(async () => answer) };

    await expect(
      resolveActorDisplayName({ userWorkspaceId: UWID }, port),
    ).resolves.toBe(`Workspace member ${UWID}`);

    answer = identity;

    await expect(
      resolveActorDisplayName({ userWorkspaceId: UWID }, port),
    ).resolves.toContain('Priya Raman');
    expect(port.read).toHaveBeenCalledTimes(2);
  });

  it('says so plainly, and asks nobody, when the request identified no member', async () => {
    const port = portReturning(identity);

    await expect(
      resolveActorDisplayName({ userWorkspaceId: null }, port),
    ).resolves.toBe('Unidentified workspace member');
    await expect(resolveActorDisplayName({}, port)).resolves.toBe(
      'Unidentified workspace member',
    );

    expect(port.read).not.toHaveBeenCalled();
  });

  it('returns a string rather than throwing when the lookup throws', async () => {
    // The shipped port swallows its own errors, but a port that does not must
    // never be able to take an audit row down with it.
    const port: ActorIdentityPort = {
      read: vi.fn(async () => {
        throw new Error('metadata unreachable');
      }),
    };

    await expect(
      resolveActorDisplayName({ userWorkspaceId: UWID }, port),
    ).resolves.toBe(`Workspace member ${UWID}`);
  });
});
