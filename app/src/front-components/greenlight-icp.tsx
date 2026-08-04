import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { defineFrontComponent } from 'twenty-sdk/define';
import { enqueueSnackbar } from 'twenty-sdk/front-component';

import {
  ICP_CLIENT_PATH,
  ICP_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/icp-identifiers';
import type { IcpImpact } from 'src/icp/icp-impact';
import type {
  IcpProposal,
  IcpSelection,
  IcpValueDimensionProposal,
} from 'src/icp/icp-proposal';
import {
  mergeBucketsIntoBands,
  toPlainBand,
  type HeadcountBucket,
} from 'src/icp/icp-size-bands';
import type { IcpStatus } from 'src/icp/icp-status';

/**
 * "Ideal customer profile" — the surface that makes an inert ICP impossible to
 * miss, and a proposed one impossible to apply blind.
 *
 * ## Why this leads with a number, twice
 *
 * The backfill panel established the pattern and the reason holds harder here.
 * The defect is not "the ICP is empty" — an empty ICP is the correct shipped
 * default, and the engine handles it correctly by dropping the three rules from
 * both sides of the weighting. The defect is that **the consequence is
 * invisible**: three rules quietly report `not_applicable`, forty points of the
 * model do nothing, and the score that comes out still looks like a score. So
 * the first thing on this page is not a button and not a warning triangle, it is
 * the arithmetic: *this many points of your model are switched off, which is this
 * percentage of it, and it is the part that decides fit.*
 *
 * The second number is the impact preview, and it exists for the mirror-image
 * reason. Writing an ICP changes every future score, and a profile that reads
 * perfectly can still hold a thousand leads a team is working from — because the
 * rules that were exempt start failing on records that simply have no industry
 * recorded. Nobody can predict that from the profile. They can only be shown it,
 * measured, before they commit. So Apply stays disabled until an impact has been
 * measured against the exact profile on screen, and it re-disables the moment a
 * checkbox changes.
 *
 * ## Why the suggestion is a proposal and never an application
 *
 * Every chip below is a value somebody in this workspace typed into a Company
 * record, with the count next to it. Greenlight has no opinion about which of
 * them the business sells to and cannot acquire one from a CRM export — an ICP is
 * a commercial decision. What it can do is put the evidence in front of the
 * person who does have that opinion, and make it cheap for them to say "those
 * four, not those nine".
 *
 * ## Nothing here is trusted
 *
 * The panel posts an action and a profile; the logic function re-validates both
 * against closed lists, re-measures the impact server-side before writing, and
 * takes the requester's identity from the authenticated request. The confirmation
 * checkbox is a courtesy — the server requires `confirm: true` in the body and
 * would refuse without it — so the honesty is in the copy, not in the guard.
 */

const GO = '#1F8A4C';
const WARN = '#B54708';
const STOP = '#B42318';
const INK = '#333';
const MUTED = '#888';

const PANEL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  padding: '20px',
  height: '100%',
  overflowY: 'auto',
  boxSizing: 'border-box',
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: '13px',
  color: INK,
};

const CARD_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  padding: '14px 16px',
  borderRadius: '10px',
  border: '1px solid #e0e0e0',
};

interface IcpResponse {
  readonly outcome?: string;
  readonly message?: string;
  readonly status?: IcpStatus | null;
  readonly proposal?: IcpProposal | null;
  readonly impact?: IcpImpact | null;
  readonly selection?: IcpSelection | null;
  readonly warnings?: readonly string[];
  readonly notes?: readonly string[];
  readonly rescore?: { started: boolean; message: string } | null;
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

const formatMoment = (iso: string | null | undefined): string => {
  if (iso === null || iso === undefined) {
    return '—';
  }

  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
};

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** Rule ids are how the trace names these; nobody outside the code says them. */
const DIMENSION_COPY: Record<string, string> = {
  'icp.industry': 'Industry',
  'icp.region': 'Region',
  'icp.company-size': 'Company size',
};

const FIELD_COPY: Record<string, string> = {
  industry: 'an industry',
  region: 'a country or region',
  employeeCount: 'an employee count',
};

const CONFIDENCE_COPY: Record<string, { label: string; color: string }> = {
  none: { label: 'no evidence', color: MUTED },
  low: { label: 'thin evidence', color: WARN },
  moderate: { label: 'moderate evidence', color: INK },
  high: { label: 'strong evidence', color: GO },
};

const Chip = ({
  checked,
  onToggle,
  title,
  subtitle,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  title: string;
  subtitle: string;
  disabled: boolean;
}) => (
  <label
    style={{
      display: 'flex',
      gap: '10px',
      alignItems: 'flex-start',
      padding: '8px 10px',
      borderRadius: '8px',
      border: `1px solid ${checked ? '#999' : '#e8e8e8'}`,
      background: checked ? '#fafafa' : '#fff',
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}
  >
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onToggle}
      style={{ marginTop: '2px' }}
    />
    <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontWeight: 500 }}>{title}</span>
      <span style={{ color: MUTED, fontSize: '12px' }}>{subtitle}</span>
    </span>
  </label>
);

const Stat = ({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
    <span style={{ color: MUTED, fontSize: '12px' }}>{label}</span>
    <span style={{ fontWeight: 600, color: color ?? INK }}>{value}</span>
  </div>
);

const button = (
  primary: boolean,
  disabled: boolean,
): React.CSSProperties => ({
  padding: '10px 16px',
  borderRadius: '8px',
  border: '1px solid #e0e0e0',
  background: disabled ? '#f5f5f5' : primary ? GO : '#fff',
  color: disabled ? '#aaa' : primary ? '#fff' : INK,
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

/** Does a proposed band already accept everything in this bucket? */
const bucketIsCovered = (
  bucket: HeadcountBucket,
  bands: IcpSelection['sizeBands'],
): boolean =>
  bands.some(
    (band) =>
      bucket.minEmployees >= band.minEmployees &&
      (band.maxEmployees === null ||
        (bucket.maxEmployees !== null &&
          bucket.maxEmployees <= band.maxEmployees)),
  );

const GreenlightIcp = () => {
  const [state, setState] = useState<IcpResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [industryPicks, setIndustryPicks] = useState<readonly string[]>([]);
  const [regionPicks, setRegionPicks] = useState<readonly string[]>([]);
  const [bucketPicks, setBucketPicks] = useState<readonly string[]>([]);
  const [extraIndustry, setExtraIndustry] = useState('');
  const [extraRegion, setExtraRegion] = useState('');
  const [customIndustries, setCustomIndustries] = useState<readonly string[]>([]);
  const [customRegions, setCustomRegions] = useState<readonly string[]>([]);
  /** The profile the impact on screen was measured against. */
  const [measured, setMeasured] = useState<string | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [rescore, setRescore] = useState(true);
  const mounted = useRef(true);

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<IcpResponse | null> => {
      try {
        const response = await new RestApiClient().post<IcpResponse>(
          ICP_CLIENT_PATH,
          body,
        );

        if (mounted.current) {
          setState(response ?? null);
        }

        return response ?? null;
      } catch (error) {
        if (mounted.current) {
          enqueueSnackbar({ message: serverMessage(error), variant: 'error' });
        }

        return null;
      }
    },
    [],
  );

  useEffect(() => {
    mounted.current = true;

    void post({ action: 'status' });

    return () => {
      mounted.current = false;
    };
  }, [post]);

  const proposal = state?.proposal ?? null;
  const status = state?.status ?? null;
  const impact = state?.impact ?? null;

  const industryClusters = useMemo(
    () =>
      proposal === null
        ? []
        : [...proposal.industry.suggestions, ...proposal.industry.alternatives],
    [proposal],
  );

  const regionClusters = useMemo(
    () =>
      proposal === null
        ? []
        : [...proposal.region.suggestions, ...proposal.region.alternatives],
    [proposal],
  );

  const buckets = proposal?.size.buckets ?? [];

  /** Seed the checkboxes from a fresh proposal, once per proposal. */
  useEffect(() => {
    if (proposal === null) {
      return;
    }

    setIndustryPicks(proposal.industry.suggestions.map((one) => one.label));
    setRegionPicks(proposal.region.suggestions.map((one) => one.label));
    setBucketPicks(
      proposal.size.buckets
        .filter((bucket) =>
          bucketIsCovered(bucket, proposal.selection.sizeBands),
        )
        .map((bucket) => bucket.label),
    );
    setCustomIndustries([]);
    setCustomRegions([]);
  }, [proposal]);

  const selection: IcpSelection = useMemo(
    () => ({
      industries: [
        ...industryClusters
          .filter((cluster) => industryPicks.includes(cluster.label))
          .flatMap((cluster) => cluster.values),
        ...customIndustries,
      ],
      regions: [
        ...regionClusters
          .filter((cluster) => regionPicks.includes(cluster.label))
          .flatMap((cluster) => cluster.values),
        ...customRegions,
      ],
      // The same helper the server used to build the proposal, on the same
      // buckets — so an untouched proposal serialises to exactly what was
      // already measured and Apply is reachable without a redundant round trip.
      sizeBands: mergeBucketsIntoBands(bucketPicks, buckets).map(toPlainBand),
    }),
    [
      industryClusters,
      industryPicks,
      customIndustries,
      regionClusters,
      regionPicks,
      customRegions,
      buckets,
      bucketPicks,
    ],
  );

  const selectionKey = JSON.stringify(selection);
  const impactIsCurrent = measured === selectionKey && impact !== null;
  const selectionIsEmpty =
    selection.industries.length === 0 &&
    selection.regions.length === 0 &&
    selection.sizeBands.length === 0;

  const act = async (
    action: string,
    body: Record<string, unknown> = {},
  ): Promise<void> => {
    setBusy(action);

    const response = await post({ action, ...body });

    if (response?.message !== undefined && response.message !== '') {
      enqueueSnackbar({
        message: response.message,
        variant: response.outcome === 'applied' ? 'success' : 'info',
      });
    }

    // Both `propose` and `preview` come back with an impact and the profile it
    // was measured against. Recording that profile verbatim is what makes
    // "these numbers describe what is on screen" a fact rather than a hope: the
    // moment a checkbox moves, the derived profile stops matching and Apply
    // goes back to being unreachable.
    if (
      response !== null &&
      (action === 'preview' || action === 'propose') &&
      response.selection !== null &&
      response.selection !== undefined &&
      response.impact !== null &&
      response.impact !== undefined
    ) {
      setMeasured(JSON.stringify(response.selection));
    }

    if (response?.outcome === 'applied' || response?.outcome === 'left_open') {
      setConfirmApply(false);
      setMeasured(null);
    }

    setBusy(null);
  };

  const toggle = (
    values: readonly string[],
    setter: (next: readonly string[]) => void,
    label: string,
  ) => {
    setConfirmApply(false);
    setter(
      values.includes(label)
        ? values.filter((one) => one !== label)
        : [...values, label],
    );
  };

  const disabled = busy !== null;

  return (
    <div style={PANEL_STYLE}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <strong style={{ fontSize: '15px' }}>Ideal customer profile</strong>
        <span style={{ color: MUTED, lineHeight: 1.5 }}>
          Which industries, regions and company sizes count as a fit. Greenlight
          ships this empty on purpose — it cannot know your market — and until you
          fill it in, the part of the score that judges fit does nothing.
        </span>
      </div>

      {state === null ? (
        <span style={{ color: MUTED }}>Checking…</span>
      ) : status === null ? (
        <div style={{ ...CARD_STYLE, borderColor: `${WARN}55` }}>
          <span style={{ color: WARN, lineHeight: 1.5 }}>
            {state.message !== undefined && state.message !== ''
              ? state.message
              : 'Greenlight could not read its configuration.'}
          </span>
        </div>
      ) : (
        <>
          <div
            style={{
              ...CARD_STYLE,
              borderColor: status.idlePoints === 0 ? `${GO}55` : `${WARN}55`,
              background: status.idlePoints === 0 ? `${GO}0F` : `${WARN}0A`,
              gap: '6px',
            }}
          >
            <strong
              style={{
                color: status.idlePoints === 0 ? GO : WARN,
                fontSize: '15px',
              }}
            >
              {status.idlePoints === 0
                ? 'Your profile is scoring'
                : `${status.idlePoints} of ${status.totalPoints} scoring points are switched off`}
            </strong>
            <span style={{ color: MUTED, lineHeight: 1.6 }}>
              {status.headline}
            </span>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '12px',
                marginTop: '6px',
              }}
            >
              {status.dimensions.map((dimension) => (
                <Stat
                  key={dimension.ruleId}
                  label={dimension.name}
                  color={dimension.idle ? WARN : GO}
                  value={
                    dimension.configured
                      ? `${dimension.entryCount} set · ${dimension.weight} pts`
                      : `not set · ${dimension.weight} pts idle`
                  }
                />
              ))}
            </div>

            <span style={{ color: MUTED, fontSize: '12px', marginTop: '4px' }}>
              {status.review.decision === 'APPLIED'
                ? `Profile applied ${formatMoment(status.review.reviewedAt)}.`
                : status.review.decision === 'LEFT_OPEN'
                  ? `Deliberately left open ${formatMoment(status.review.reviewedAt)}. Scores are built from contact quality and compliance alone, and that is a decision on record.`
                  : 'Nobody has reviewed this profile yet.'}
            </span>
          </div>

          {(state.notes ?? []).length > 0 && (
            <div style={{ ...CARD_STYLE, gap: '6px' }}>
              <strong style={{ fontSize: '13px' }}>Where this comes from</strong>
              {(state.notes ?? []).map((note) => (
                <span
                  key={note}
                  style={{ color: MUTED, fontSize: '12px', lineHeight: 1.5 }}
                >
                  {note}
                </span>
              ))}
            </div>
          )}

          {(state.warnings ?? []).length > 0 &&
            (state.warnings ?? []).map((warning) => (
              <span
                key={warning}
                style={{ color: WARN, fontSize: '12px', lineHeight: 1.5 }}
              >
                {warning}
              </span>
            ))}

          {proposal === null ? (
            <>
              <span style={{ color: MUTED, lineHeight: 1.6 }}>
                Greenlight can read your existing Companies and show you which
                industries, regions and sizes they actually cluster into. It is a
                suggestion with the evidence attached, not a setting — nothing is
                written until you say so.
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void act('propose')}
                style={button(true, disabled)}
              >
                {busy === 'propose'
                  ? 'Reading your companies…'
                  : 'Suggest a profile from my data'}
              </button>
            </>
          ) : (
            <>
              <ValueDimension
                dimension={proposal.industry}
                clusters={industryClusters}
                picks={industryPicks}
                onToggle={(label) =>
                  toggle(industryPicks, setIndustryPicks, label)
                }
                custom={customIndustries}
                onRemoveCustom={(value) => {
                  setConfirmApply(false);
                  setCustomIndustries(
                    customIndustries.filter((one) => one !== value),
                  );
                }}
                draft={extraIndustry}
                onDraft={setExtraIndustry}
                onAdd={() => {
                  const value = extraIndustry.trim();

                  if (value.length > 0 && !customIndustries.includes(value)) {
                    setConfirmApply(false);
                    setCustomIndustries([...customIndustries, value]);
                  }

                  setExtraIndustry('');
                }}
                disabled={disabled}
              />

              <ValueDimension
                dimension={proposal.region}
                clusters={regionClusters}
                picks={regionPicks}
                onToggle={(label) => toggle(regionPicks, setRegionPicks, label)}
                custom={customRegions}
                onRemoveCustom={(value) => {
                  setConfirmApply(false);
                  setCustomRegions(customRegions.filter((one) => one !== value));
                }}
                draft={extraRegion}
                onDraft={setExtraRegion}
                onAdd={() => {
                  const value = extraRegion.trim();

                  if (value.length > 0 && !customRegions.includes(value)) {
                    setConfirmApply(false);
                    setCustomRegions([...customRegions, value]);
                  }

                  setExtraRegion('');
                }}
                disabled={disabled}
              />

              <div style={CARD_STYLE}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '8px',
                    alignItems: 'baseline',
                  }}
                >
                  <strong>Company size</strong>
                  <span
                    style={{
                      color:
                        CONFIDENCE_COPY[proposal.size.confidence]?.color ??
                        MUTED,
                      fontSize: '12px',
                    }}
                  >
                    {CONFIDENCE_COPY[proposal.size.confidence]?.label ??
                      proposal.size.confidence}
                  </span>
                </div>
                <span style={{ color: MUTED, fontSize: '12px', lineHeight: 1.5 }}>
                  {proposal.size.reason}
                </span>
                {proposal.size.buckets.map((bucket) => (
                  <Chip
                    key={bucket.label}
                    checked={bucketPicks.includes(bucket.label)}
                    disabled={disabled}
                    onToggle={() =>
                      toggle(bucketPicks, setBucketPicks, bucket.label)
                    }
                    title={bucket.label}
                    subtitle={
                      bucket.count === 0
                        ? 'no companies of this size on record'
                        : `${bucket.count.toLocaleString()} companies · ${percent(bucket.share)} of those with a headcount`
                    }
                  />
                ))}
                {proposal.size.known > 0 && (
                  <span style={{ color: MUTED, fontSize: '12px' }}>
                    Anything outside every band you tick fails the size rule, not
                    just scores lower.
                  </span>
                )}
              </div>

              <ImpactCard
                impact={impact}
                current={impactIsCurrent}
                empty={selectionIsEmpty}
                busy={busy === 'preview'}
                disabled={disabled || selectionIsEmpty}
                onMeasure={() => {
                  setMeasured(selectionKey);
                  void act('preview', { selection });
                }}
              />

              <div style={{ ...CARD_STYLE, gap: '12px' }}>
                <label
                  style={{
                    display: 'flex',
                    gap: '10px',
                    alignItems: 'flex-start',
                    lineHeight: 1.5,
                    color: impactIsCurrent ? INK : MUTED,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={confirmApply}
                    disabled={disabled || !impactIsCurrent}
                    onChange={(event) => setConfirmApply(event.target.checked)}
                    style={{ marginTop: '2px' }}
                  />
                  <span>
                    I have read the impact above and want this profile applied.
                    Every lead scored from now on is judged against it.
                  </span>
                </label>

                <label
                  style={{
                    display: 'flex',
                    gap: '10px',
                    alignItems: 'flex-start',
                    lineHeight: 1.5,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={rescore}
                    disabled={disabled}
                    onChange={(event) => setRescore(event.target.checked)}
                    style={{ marginTop: '2px' }}
                  />
                  <span>
                    Re-score the leads already in the CRM afterwards. Without
                    this, existing leads keep the scores they were given under the
                    old profile and only new or edited leads use the new one — so
                    the queue would be judged two different ways at once. The
                    re-score runs in the background at about 30 leads a minute and
                    honours anything a colleague released by hand.
                  </span>
                </label>

                <button
                  type="button"
                  disabled={disabled || !impactIsCurrent || !confirmApply}
                  onClick={() =>
                    void act('apply', { selection, confirm: true, rescore })
                  }
                  style={button(
                    true,
                    disabled || !impactIsCurrent || !confirmApply,
                  )}
                >
                  {busy === 'apply' ? 'Applying…' : 'Apply this profile'}
                </button>

                {state.rescore !== null && state.rescore !== undefined && (
                  <span
                    style={{
                      color: state.rescore.started ? GO : MUTED,
                      fontSize: '12px',
                      lineHeight: 1.5,
                    }}
                  >
                    {state.rescore.message}
                  </span>
                )}
              </div>
            </>
          )}

          {status.review.decision === 'NOT_REVIEWED' && (
            <div style={{ ...CARD_STYLE, gap: '8px' }}>
              <strong style={{ fontSize: '13px' }}>
                Or say you meant to leave it open
              </strong>
              <span style={{ color: MUTED, fontSize: '12px', lineHeight: 1.5 }}>
                Plenty of businesses genuinely sell to every industry in every
                country. If that is you, record it — the profile stays permissive,
                scores keep being built from contact quality and compliance, and
                this page stops telling you something is missing when nothing is.
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void act('leave-open')}
                style={button(false, disabled)}
              >
                {busy === 'leave-open'
                  ? 'Recording…'
                  : 'Leave the profile open, deliberately'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Sub-components                                                              */
/* -------------------------------------------------------------------------- */

const ValueDimension = ({
  dimension,
  clusters,
  picks,
  onToggle,
  custom,
  onRemoveCustom,
  draft,
  onDraft,
  onAdd,
  disabled,
}: {
  dimension: IcpValueDimensionProposal;
  clusters: IcpProposal['industry']['suggestions'];
  picks: readonly string[];
  onToggle: (label: string) => void;
  custom: readonly string[];
  onRemoveCustom: (value: string) => void;
  draft: string;
  onDraft: (value: string) => void;
  onAdd: () => void;
  disabled: boolean;
}) => {
  const [showAll, setShowAll] = useState(false);
  const suggested = new Set(dimension.suggestions.map((one) => one.label));
  const visible = showAll
    ? clusters
    : clusters.filter((cluster) => suggested.has(cluster.label));
  const confidence = CONFIDENCE_COPY[dimension.confidence];

  return (
    <div style={CARD_STYLE}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '8px',
          alignItems: 'baseline',
        }}
      >
        <strong>
          {dimension.dimension === 'industry' ? 'Industries' : 'Regions'}
        </strong>
        <span style={{ color: confidence?.color ?? MUTED, fontSize: '12px' }}>
          {confidence?.label ?? dimension.confidence}
        </span>
      </div>

      <span style={{ color: MUTED, fontSize: '12px', lineHeight: 1.5 }}>
        {dimension.reason}
      </span>

      {visible.map((cluster) => (
        <Chip
          key={cluster.label}
          checked={picks.includes(cluster.label)}
          disabled={disabled}
          onToggle={() => onToggle(cluster.label)}
          title={cluster.label}
          subtitle={`${cluster.count.toLocaleString()} companies · ${percent(
            cluster.share,
          )}${
            cluster.values.length > 1
              ? ` · written ${cluster.values.length} ways: ${cluster.values.join(', ')}`
              : ''
          }${cluster.examples.length > 0 ? ` · e.g. ${cluster.examples.join(', ')}` : ''}`}
        />
      ))}

      {clusters.length > visible.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'none',
            padding: 0,
            color: INK,
            textDecoration: 'underline',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          Show the other {clusters.length - visible.length} found in your data
        </button>
      )}

      {custom.map((value) => (
        <div
          key={value}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '8px',
            alignItems: 'center',
            padding: '8px 10px',
            borderRadius: '8px',
            border: '1px dashed #999',
          }}
        >
          <span>
            {value}{' '}
            <span style={{ color: MUTED, fontSize: '12px' }}>
              · added by hand, not seen in your data
            </span>
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRemoveCustom(value)}
            style={{
              border: 'none',
              background: 'none',
              color: STOP,
              cursor: 'pointer',
            }}
          >
            Remove
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={
            dimension.dimension === 'industry'
              ? 'Add an industry you sell to but have no customers in yet'
              : 'Add a region you cover but have no customers in yet'
          }
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onAdd();
            }
          }}
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: '8px',
            border: '1px solid #e0e0e0',
            fontSize: '13px',
          }}
        />
        <button
          type="button"
          disabled={disabled || draft.trim().length === 0}
          onClick={onAdd}
          style={button(false, disabled || draft.trim().length === 0)}
        >
          Add
        </button>
      </div>

      {/*
        The example has to come from the dimension being edited. This card is
        rendered twice — once for industries, once for regions — and a regions
        card that illustrates case-insensitive matching with “SaaS” is telling
        an admin about a value that cannot appear in the column they are
        looking at.
      */}
      <span style={{ color: MUTED, fontSize: '12px', lineHeight: 1.5 }}>
        Matching is exact, ignoring case and spacing. Ticking a row writes every
        spelling of it that exists in your data, so a lead recorded as{' '}
        {dimension.dimension === 'industry'
          ? '“SaaS” and one recorded as “saas”'
          : '“United Kingdom” and one recorded as “united kingdom”'}{' '}
        both match.
      </span>
    </div>
  );
};

const ImpactCard = ({
  impact,
  current,
  empty,
  busy,
  disabled,
  onMeasure,
}: {
  impact: IcpImpact | null;
  current: boolean;
  empty: boolean;
  busy: boolean;
  disabled: boolean;
  onMeasure: () => void;
}) => {
  const unreadable = (impact?.readability ?? []).filter(
    (entry) => entry.active && entry.readable === 0 && entry.unreadable > 0,
  );

  return (
    <div
      style={{
        ...CARD_STYLE,
        borderColor:
          current && impact !== null && impact.newlyGated > 0
            ? `${WARN}55`
            : '#e0e0e0',
      }}
    >
      <strong>What applying this would change</strong>

      {empty ? (
        <span style={{ color: MUTED, lineHeight: 1.5 }}>
          Nothing is ticked, so there is no profile to measure. An empty profile
          is the state you are already in.
        </span>
      ) : impact === null || !current ? (
        <span style={{ color: MUTED, lineHeight: 1.5 }}>
          {impact === null
            ? 'Greenlight scores a sample of your leads twice — once as they stand and once against this profile — so you can see who would start being held before anything is written.'
            : 'You changed the profile, so the numbers below no longer describe it. Measure again.'}
        </span>
      ) : null}

      {impact !== null && current && !empty && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '12px',
            }}
          >
            <Stat
              label="Would start being held"
              color={impact.newlyGated > 0 ? WARN : GO}
              value={`${impact.newlyGated.toLocaleString()} of ${impact.sampled.toLocaleString()} sampled`}
            />
            <Stat
              label="Would start passing"
              value={impact.newlyApproved.toLocaleString()}
            />
            <Stat
              label="Average score"
              value={`${impact.averageScoreBefore ?? '—'} → ${impact.averageScoreAfter ?? '—'}`}
            />
            <Stat
              label="Unchanged"
              value={impact.unchanged.toLocaleString()}
            />
          </div>

          {impact.estimatedNewlyGated !== null &&
            impact.totalLeads !== null &&
            impact.totalLeads > impact.sampled && (
              <span
                style={{
                  color: impact.estimatedNewlyGated > 0 ? WARN : MUTED,
                  lineHeight: 1.5,
                }}
              >
                Scaled to all {impact.totalLeads.toLocaleString()} leads, roughly{' '}
                <strong>
                  {impact.estimatedNewlyGated.toLocaleString()} currently-passing
                  leads
                </strong>{' '}
                would start being held for review. That is an estimate from a
                sample of {impact.sampled.toLocaleString()}, not a count.
              </span>
            )}

          {unreadable.length > 0 && (
            <span style={{ color: STOP, lineHeight: 1.5 }}>
              Greenlight could not read{' '}
              {unreadable
                .map((entry) => FIELD_COPY[entry.fieldKey] ?? entry.fieldKey)
                .join(' or ')}{' '}
              on a single one of the {impact.sampled.toLocaleString()} leads
              sampled. It looks for{' '}
              {unreadable[0]?.candidates.join(', ') ?? 'those fields'} on the lead
              record. Applied as it stands, that rule would fail every lead for
              want of data rather than filter anything — the profile is not what
              is wrong, the data behind it is missing.
            </span>
          )}

          {impact.readability
            .filter((entry) => entry.active && entry.readable > 0)
            .map((entry) => (
              <span
                key={entry.ruleId}
                style={{ color: MUTED, fontSize: '12px', lineHeight: 1.5 }}
              >
                {DIMENSION_COPY[entry.ruleId] ?? entry.ruleId}: readable on{' '}
                {entry.readable.toLocaleString()} of{' '}
                {impact.sampled.toLocaleString()} sampled leads
                {entry.resolvedPaths.length > 0
                  ? ` (from ${entry.resolvedPaths.join(', ')})`
                  : ''}
                ; {entry.matched.toLocaleString()} would match,{' '}
                {entry.mismatched.toLocaleString()} would not.
              </span>
            ))}

          {impact.examples.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600 }}>
                Leads that would start being held
              </span>
              {impact.examples.map((example) => (
                <span
                  key={`${example.leadId ?? example.display}`}
                  style={{ color: MUTED, fontSize: '12px', lineHeight: 1.5 }}
                >
                  {example.display}: {example.scoreBefore ?? '—'} →{' '}
                  {example.scoreAfter ?? '—'} · {example.reason}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={onMeasure}
        style={button(false, disabled)}
      >
        {busy
          ? 'Measuring…'
          : impact === null
            ? 'Measure the impact'
            : 'Measure again'}
      </button>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: ICP_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-icp',
  description:
    'Shows how much of the Greenlight scoring model is idle for want of an ideal-customer profile, proposes one from the workspace’s own companies with the evidence attached, previews what applying it would change, and applies it.',
  component: GreenlightIcp,
});
