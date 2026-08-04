/**
 * Turning ticked headcount buckets into the bands that get written.
 *
 * A module of its own, importing nothing, for one reason: both the proposal
 * (server side) and the panel (browser side) have to produce **byte-identical**
 * bands from the same ticks. The panel disables Apply until the impact on screen
 * was measured against the exact profile on screen, and it decides "exact" by
 * comparing the serialised selection — so a panel that merged buckets even
 * slightly differently from the server would mark a freshly-computed impact
 * stale and make the user re-measure a profile nothing had changed about.
 *
 * Matching is by `label` rather than by array index or object identity, because
 * the panel's copy of these buckets has been through JSON and is not the same
 * object the server merged.
 */

export interface HeadcountBucket {
  readonly label: string;
  readonly minEmployees: number;
  /** `null` means unbounded — the top bucket. */
  readonly maxEmployees: number | null;
  readonly count: number;
  readonly share: number;
}

export interface MergedSizeBand {
  readonly label: string;
  readonly minEmployees: number;
  readonly maxEmployees: number | null;
  readonly count: number;
  readonly share: number;
}

/**
 * Fuse adjacent buckets into one band a human would name.
 *
 * Adjacency is decided against `all`, so ticking 1–10 and 51–200 while leaving
 * 11–50 alone produces two bands rather than one that quietly swallows the gap.
 * That gap is a real statement — "we sell to the very small and the mid-market,
 * not the bit in between" — and merging over it would write a profile the person
 * did not choose.
 */
export const mergeBucketsIntoBands = (
  chosenLabels: readonly string[],
  all: readonly HeadcountBucket[],
): MergedSizeBand[] => {
  const chosen = new Set(chosenLabels);
  const bands: MergedSizeBand[] = [];
  let run: HeadcountBucket[] = [];

  const flush = () => {
    const first = run[0];
    const last = run[run.length - 1];

    if (first === undefined || last === undefined) {
      run = [];
      return;
    }

    bands.push({
      label:
        last.maxEmployees === null
          ? `${first.minEmployees.toLocaleString('en-US')}+ employees`
          : `${first.minEmployees.toLocaleString('en-US')}–${last.maxEmployees.toLocaleString('en-US')} employees`,
      minEmployees: first.minEmployees,
      maxEmployees: last.maxEmployees,
      count: run.reduce((sum, bucket) => sum + bucket.count, 0),
      share: run.reduce((sum, bucket) => sum + bucket.share, 0),
    });

    run = [];
  };

  for (const bucket of all) {
    if (chosen.has(bucket.label)) {
      run.push(bucket);
      continue;
    }

    flush();
  }

  flush();

  return bands;
};

/** The three keys the config record and the scoring engine care about. */
export const toPlainBand = ({
  label,
  minEmployees,
  maxEmployees,
}: MergedSizeBand): {
  label: string;
  minEmployees: number;
  maxEmployees: number | null;
} => ({ label, minEmployees, maxEmployees });
