import { describe, expect, it } from 'vitest';

import { SIZE_BUCKETS } from 'src/icp/icp-analysis';
import {
  mergeBucketsIntoBands,
  toPlainBand,
  type HeadcountBucket,
} from 'src/icp/icp-size-bands';

const buckets: HeadcountBucket[] = SIZE_BUCKETS.map((bucket, index) => ({
  ...bucket,
  count: index + 1,
  share: (index + 1) / 21,
}));

const labels = (indexes: number[]): string[] =>
  indexes.map((index) => buckets[index]?.label ?? '');

describe('mergeBucketsIntoBands', () => {
  it('fuses adjacent buckets into one band', () => {
    const bands = mergeBucketsIntoBands(labels([1, 2]), buckets);

    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ minEmployees: 11, maxEmployees: 200 });
  });

  it('keeps a gap a gap, because the gap is a statement', () => {
    // "The very small and the mid-market, not the bit in between" is a real
    // profile. Merging over the hole would write one the person did not choose.
    const bands = mergeBucketsIntoBands(labels([0, 3]), buckets);

    expect(bands.map((band) => band.minEmployees)).toEqual([1, 201]);
    expect(bands[0]?.maxEmployees).toBe(10);
  });

  it('leaves the top band unbounded', () => {
    expect(mergeBucketsIntoBands(labels([5]), buckets)[0]?.maxEmployees).toBeNull();
  });

  it('returns nothing when nothing is ticked', () => {
    expect(mergeBucketsIntoBands([], buckets)).toEqual([]);
  });

  it('matches by label, so a copy that has been through JSON merges the same', () => {
    const roundTripped = JSON.parse(JSON.stringify(buckets)) as HeadcountBucket[];

    expect(mergeBucketsIntoBands(labels([1, 2]), roundTripped)).toEqual(
      mergeBucketsIntoBands(labels([1, 2]), buckets),
    );
  });

  it('ignores a label that is not one of the buckets', () => {
    expect(mergeBucketsIntoBands(['nonsense'], buckets)).toEqual([]);
  });

  it('strips the evidence columns for the config record', () => {
    expect(
      toPlainBand({
        label: '11–50 employees',
        minEmployees: 11,
        maxEmployees: 50,
        count: 9,
        share: 0.4,
      }),
    ).toEqual({ label: '11–50 employees', minEmployees: 11, maxEmployees: 50 });
  });
});
