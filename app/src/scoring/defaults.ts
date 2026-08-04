/**
 * Seeded defaults.
 *
 * "Defaults are the feature." A configurable product that ships empty is a
 * homework assignment — these values are what the post-install hook writes into
 * the config record, and they are also the fall-back the engine uses whenever
 * configuration is missing or unusable.
 *
 * The ICP lists start empty on purpose: an empty list means "no opinion", so a
 * fresh install is permissive and nothing is gated for being in the wrong
 * industry before an admin has said what the right industry is.
 */

import type {
  FieldMapping,
  IcpConfig,
  ScoringBand,
} from 'src/scoring/types';

/**
 * Default paths into the lead record, tried in order. These are defaults only —
 * rule logic never mentions a field name, it asks for a logical key and the
 * mapping decides where that comes from.
 */
export const DEFAULT_FIELD_MAPPING: FieldMapping = {
  companyName: ['companyName', 'company.name', 'company', 'accountName'],
  industry: ['industry', 'company.industry', 'sector'],
  region: ['region', 'country', 'address.addressCountry', 'company.region'],
  employeeCount: ['employees', 'employeeCount', 'company.employees', 'companySize'],
  contactName: ['name', 'fullName', 'contactName', 'firstName'],
  jobTitle: ['jobTitle', 'title', 'role', 'position'],
  seniority: ['seniority', 'seniorityLevel'],
  email: ['emails', 'email', 'emails.primaryEmail', 'workEmail'],
  phone: ['phones', 'phone', 'phones.primaryPhoneNumber', 'mobile'],
  lastVerifiedAt: ['lastVerifiedAt', 'verifiedAt', 'updatedAt', 'createdAt'],

  // Greenlight's own suppression columns. Single-candidate and not extended by
  // the Layer 3 mapping, unlike every other key here: these are fields the app
  // ships and owns, so "where does this live" has exactly one answer. A
  // workspace's *own* opt-out columns are `optedOut` below, and the compliance
  // rule takes the union of the two rather than letting either win.
  suppressed: ['greenlightSuppressed'],
  suppressionReason: ['greenlightSuppressionReason'],

  optedOut: ['optedOut', 'doNotContact', 'emailOptOut', 'unsubscribed'],
};

/** Permissive by default: no industry/region/size opinion until an admin sets one. */
export const DEFAULT_ICP: IcpConfig = {
  industries: [],
  regions: [],
  sizeBands: [],
};

/**
 * Evenly-spaced neutral bands. Published in full in the scoring-model explainer;
 * a scoring product that hides its model does not get trusted by the people
 * whose leads it rejects.
 */
export const DEFAULT_BANDS: readonly ScoringBand[] = [
  { id: 'excellent', label: 'Excellent', minScore: 85 },
  { id: 'good', label: 'Good', minScore: 70 },
  { id: 'fair', label: 'Fair', minScore: 50 },
  { id: 'poor', label: 'Poor', minScore: 0 },
];

/** The floor of the "Fair" band: fair and above is cleared to work. */
export const DEFAULT_GATE_THRESHOLD = 50;

export const DEFAULT_SHELF_LIFE_DAYS = 30;

export const DEFAULT_DECISION_MAKER_TITLES: readonly string[] = [
  'ceo',
  'cto',
  'cfo',
  'coo',
  'cmo',
  'ciso',
  'cio',
  'chief',
  'founder',
  'co-founder',
  'cofounder',
  'owner',
  'proprietor',
  'president',
  'partner',
  'principal',
  'vp',
  'vice president',
  'svp',
  'evp',
  'head of',
  'director',
  'managing director',
  'general manager',
  'board member',
];

export const DEFAULT_INFLUENCER_TITLES: readonly string[] = [
  'manager',
  'lead',
  'team lead',
  'supervisor',
  'architect',
  'consultant',
  'coordinator',
  'buyer',
  'procurement',
];

export const DEFAULT_ROLE_INBOX_LOCAL_PARTS: readonly string[] = [
  'info',
  'sales',
  'support',
  'admin',
  'contact',
  'hello',
  'hi',
  'office',
  'enquiries',
  'enquiry',
  'inquiries',
  'inquiry',
  'marketing',
  'help',
  'billing',
  'accounts',
  'accounting',
  'finance',
  'careers',
  'jobs',
  'hr',
  'team',
  'mail',
  'general',
  'noreply',
  'no-reply',
  'donotreply',
  'webmaster',
  'postmaster',
  'abuse',
];

/** Values that mean "somebody typed something rather than nothing". */
export const PLACEHOLDER_VALUES: readonly string[] = [
  '-',
  '--',
  '.',
  'n/a',
  'na',
  'n.a.',
  'none',
  'null',
  'nil',
  'unknown',
  'tbd',
  'tba',
  'test',
  'testing',
  'asdf',
  'xxx',
  '???',
  'no name',
  'not provided',
  'not set',
];
