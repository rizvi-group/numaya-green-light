import { describe, expect, it } from 'vitest';

import { MAX_ICP_VALUES, parseIcpCommand } from 'src/icp/icp-command';

const ok = (body: unknown) => {
  const parsed = parseIcpCommand(body);

  if (!parsed.ok) {
    throw new Error(`expected a parsed command, got: ${parsed.message}`);
  }

  return parsed.command;
};

describe('parseIcpCommand', () => {
  it('treats an empty body as a status read', () => {
    expect(ok(undefined)).toEqual({ action: 'status' });
    expect(ok(null)).toEqual({ action: 'status' });
    expect(ok({})).toEqual({ action: 'status' });
  });

  it('refuses an unknown action rather than defaulting to status', () => {
    const parsed = parseIcpCommand({ action: 'delete-everything' });

    expect(parsed.ok).toBe(false);
  });

  it('refuses a body that is not an object', () => {
    expect(parseIcpCommand('status').ok).toBe(false);
    expect(parseIcpCommand([]).ok).toBe(false);
  });

  it('accepts the read-only actions', () => {
    expect(ok({ action: 'propose' })).toEqual({ action: 'propose' });
    expect(ok({ action: ' Leave-Open ' })).toEqual({ action: 'leave-open' });
  });

  it('needs a selection for preview and apply', () => {
    expect(parseIcpCommand({ action: 'preview' }).ok).toBe(false);
    expect(parseIcpCommand({ action: 'apply', confirm: true }).ok).toBe(false);
  });

  it('parses a well-formed selection', () => {
    expect(
      ok({
        action: 'preview',
        selection: {
          industries: ['Manufacturing', ' Retail '],
          regions: ['Germany'],
          sizeBands: [
            { label: 'SMB', minEmployees: 1, maxEmployees: 50 },
            { minEmployees: 5001, maxEmployees: null },
          ],
        },
      }),
    ).toEqual({
      action: 'preview',
      warnings: [],
      selection: {
        industries: ['Manufacturing', 'Retail'],
        regions: ['Germany'],
        sizeBands: [
          { label: 'SMB', minEmployees: 1, maxEmployees: 50 },
          { label: '5001–∞ employees', minEmployees: 5001, maxEmployees: null },
        ],
      },
    });
  });

  it('de-duplicates the way the matcher does, so one target is stored once', () => {
    const command = ok({
      action: 'preview',
      selection: { industries: ['SaaS', 'saas ', 'SAAS'] },
    });

    expect(
      command.action === 'preview' ? command.selection.industries : [],
    ).toEqual(['SaaS']);
  });

  it('drops malformed entries and says which, rather than failing or hiding them', () => {
    const command = ok({
      action: 'preview',
      selection: {
        industries: ['Retail', 42, '', null],
        sizeBands: [
          { minEmployees: 'ten', maxEmployees: 50 },
          { minEmployees: 100, maxEmployees: 10 },
          { minEmployees: 10 },
        ],
      },
    });

    if (command.action !== 'preview') {
      throw new Error('expected a preview command');
    }

    expect(command.selection.industries).toEqual(['Retail']);
    expect(command.selection.sizeBands).toHaveLength(1);
    expect(command.warnings).toHaveLength(2);
    expect(command.warnings.join(' ')).toContain('3 industry entries');
    expect(command.warnings.join(' ')).toContain('2 size bands');
  });

  it('ignores a list that is not a list, with a warning', () => {
    const command = ok({
      action: 'preview',
      selection: { industries: 'Manufacturing', sizeBands: {} },
    });

    if (command.action !== 'preview') {
      throw new Error('expected a preview command');
    }

    expect(command.selection.industries).toEqual([]);
    expect(command.warnings).toHaveLength(2);
  });

  it('caps the number of entries', () => {
    const command = ok({
      action: 'preview',
      selection: {
        industries: Array.from(
          { length: MAX_ICP_VALUES + 5 },
          (_, index) => `Industry ${index}`,
        ),
      },
    });

    expect(
      command.action === 'preview' ? command.selection.industries.length : 0,
    ).toBe(MAX_ICP_VALUES);
  });

  it('refuses an apply that is not confirmed', () => {
    const parsed = parseIcpCommand({
      action: 'apply',
      selection: { industries: ['Retail'] },
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain('Confirm the preview');
  });

  it('refuses an apply of an empty profile and points at the honest alternative', () => {
    const parsed = parseIcpCommand({
      action: 'apply',
      confirm: true,
      selection: { industries: [], regions: [], sizeBands: [] },
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain('Leave it open');
  });

  it('accepts a confirmed apply, and defaults the re-score to off unless asked', () => {
    expect(
      ok({
        action: 'apply',
        confirm: true,
        selection: { industries: ['Retail'] },
      }),
    ).toMatchObject({ action: 'apply', rescore: false });

    expect(
      ok({
        action: 'apply',
        confirm: true,
        rescore: true,
        selection: { industries: ['Retail'] },
      }),
    ).toMatchObject({ rescore: true });
  });

  it('does not accept a truthy-but-not-true confirmation', () => {
    expect(
      parseIcpCommand({
        action: 'apply',
        confirm: 'yes',
        selection: { industries: ['Retail'] },
      }).ok,
    ).toBe(false);
  });
});
