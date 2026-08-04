import { describe, expect, it } from 'vitest';

import {
  BACKFILL_MODE_LABELS,
  parseBackfillCommand,
} from 'src/backfill/backfill-command';
import { BACKFILL_MODES } from 'src/backfill/backfill-state';

describe('parseBackfillCommand', () => {
  it('should read an empty body as the harmless action', () => {
    expect(parseBackfillCommand(undefined)).toEqual({
      ok: true,
      command: { action: 'status' },
    });
    expect(parseBackfillCommand({})).toEqual({
      ok: true,
      command: { action: 'status' },
    });
  });

  it('should default a start to the mode that only fills in blanks', () => {
    expect(parseBackfillCommand({ action: 'start' })).toEqual({
      ok: true,
      command: { action: 'start', mode: 'unscored' },
    });
  });

  it('should accept the destructive mode when it is asked for by name', () => {
    expect(parseBackfillCommand({ action: 'start', mode: 'ALL' })).toEqual({
      ok: true,
      command: { action: 'start', mode: 'all' },
    });
  });

  it('should refuse a mis-spelled mode rather than defaulting it', () => {
    // Defaulting a typo to `all` would re-score an entire workspace and
    // overwrite decisions reps are working from.
    const result = parseBackfillCommand({ action: 'start', mode: 'evrything' });

    expect(result.ok).toBe(false);
  });

  it('should refuse an unknown action rather than quietly reading status', () => {
    const result = parseBackfillCommand({ action: 'delete' });

    expect(result.ok).toBe(false);
  });

  it('should refuse a body that is not an object', () => {
    expect(parseBackfillCommand('start').ok).toBe(false);
    expect(parseBackfillCommand([]).ok).toBe(false);
  });

  it('should parse stop', () => {
    expect(parseBackfillCommand({ action: ' Stop ' })).toEqual({
      ok: true,
      command: { action: 'stop' },
    });
  });
});

describe('BACKFILL_MODE_LABELS', () => {
  it('should describe every shipped mode, so the panel cannot render a blank', () => {
    for (const mode of BACKFILL_MODES) {
      expect(BACKFILL_MODE_LABELS[mode].label.length).toBeGreaterThan(0);
      expect(BACKFILL_MODE_LABELS[mode].hint.length).toBeGreaterThan(0);
    }
  });
});
