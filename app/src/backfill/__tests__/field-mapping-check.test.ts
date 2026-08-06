import { describe, expect, it } from 'vitest';

import { configuredSelectionFields } from 'src/backfill/backfill-plan';
import {
  buildFieldExistenceProbe,
  classifyProbeRejection,
  describeFieldMappingFindings,
  fieldMappingAuditDetail,
  fieldMappingAuditName,
  mappedFieldNames,
  probeAnswered,
} from 'src/backfill/field-mapping-check';

describe('mappedFieldNames', () => {
  it('should carry the setting each name was typed into', () => {
    expect(
      mappedFieldNames({
        decisionMakerFieldName: 'seniorityLevel',
        readyForOutreachFieldName: 'leadStatus',
        optOutFieldNames: ['doNotEmail', 'gdprOptOut'],
      }),
    ).toEqual([
      { name: 'seniorityLevel', source: 'decisionMakerFieldName' },
      { name: 'leadStatus', source: 'readyForOutreachFieldName' },
      { name: 'doNotEmail', source: 'optOutFieldNames' },
      { name: 'gdprOptOut', source: 'optOutFieldNames' },
    ]);
  });

  it('should drop anything that is not a plain GraphQL identifier', () => {
    // A config field is admin-supplied text one query away from the schema. A
    // name that never reaches a request cannot be silently read as null either,
    // so there is nothing to probe and nothing to report.
    expect(
      mappedFieldNames({
        decisionMakerFieldName: 'job title',
        readyForOutreachFieldName: 'company.stage',
        optOutFieldNames: ['optedOut', 42, '', '  ', 'a-b'],
      }),
    ).toEqual([{ name: 'optedOut', source: 'optOutFieldNames' }]);
  });

  it('should trim, de-duplicate and keep the first setting that mentioned a name', () => {
    expect(
      mappedFieldNames({
        decisionMakerFieldName: '  jobTitle  ',
        optOutFieldNames: ['jobTitle', 'optedOut'],
      }),
    ).toEqual([
      { name: 'jobTitle', source: 'decisionMakerFieldName' },
      { name: 'optedOut', source: 'optOutFieldNames' },
    ]);
  });

  it('should return nothing for an unreadable config', () => {
    expect(mappedFieldNames(null)).toEqual([]);
    expect(mappedFieldNames('nonsense')).toEqual([]);
    expect(mappedFieldNames({})).toEqual([]);
  });

  it('should be the same list the page selection is built from', () => {
    // The point of the refactor: the names probed and the names selected cannot
    // drift, because there is one function producing both.
    const record = {
      decisionMakerFieldName: 'seniorityLevel',
      readyForOutreachFieldName: 'leadStatus',
      optOutFieldNames: ['doNotEmail'],
    };

    expect(configuredSelectionFields(record)).toEqual(
      mappedFieldNames(record).map((mapped) => mapped.name),
    );
  });
});

describe('buildFieldExistenceProbe', () => {
  it('should put the name in the filter and never in the selection', () => {
    // This assertion is the whole defect. Twenty validates arguments and does
    // not validate selection sets, so a name asked about by selection comes back
    // null on every workspace and the probe answers "present" always.
    const probe = buildFieldExistenceProbe('people', 'seniorityLevel');

    expect(probe).toEqual({
      people: {
        __args: {
          first: 1,
          filter: { seniorityLevel: { is: 'NOT_NULL' } },
        },
        edges: { node: { id: true } },
      },
    });

    expect(JSON.stringify(probe['people']).includes('"edges"')).toBe(true);
    expect(
      Object.keys(
        (
          (probe['people'] as Record<string, unknown>)['edges'] as Record<
            string,
            unknown
          >
        )['node'] as Record<string, unknown>,
      ),
    ).toEqual(['id']);
  });
});

describe('probeAnswered', () => {
  it('should require the connection to be present', () => {
    expect(probeAnswered('people', { people: { edges: [] } })).toBe(true);
    // A transport that returns `{ errors, data: null }` without throwing would
    // otherwise make every probe look like a success.
    expect(probeAnswered('people', {})).toBe(false);
    expect(probeAnswered('people', null)).toBe(false);
    expect(probeAnswered('people', { people: null })).toBe(false);
  });
});

describe('classifyProbeRejection', () => {
  it('should read Twenty’s "no such field" rejections as absent', () => {
    expect(
      classifyProbeRejection(
        'seniorityLevel',
        'Error: Object person doesn\'t have any "seniorityLevel" field.',
      ),
    ).toBe('absent');

    expect(
      classifyProbeRejection(
        'seniorityLevel',
        'Field "seniorityLevel" is not defined by type "PersonFilterInput".',
      ),
    ).toBe('absent');
  });

  it('should read a composite rejection as present', () => {
    // The field is plainly there — the probe simply cannot ask about it this
    // way. Reporting a column an admin can see on the record page as missing is
    // the failure mode that gets every future notice ignored.
    expect(
      classifyProbeRejection(
        'emails',
        'Sub field "is" not found for composite type: EMAILS',
      ),
    ).toBe('present');
  });

  it('should say nothing when the rejection is about something else', () => {
    expect(
      classifyProbeRejection(
        'seniorityLevel',
        'Object person doesn\'t have any "someOtherField" field.',
      ),
    ).toBe('inconclusive');
  });

  it('should say nothing when the message is not one it recognises', () => {
    // Fail-open, stated as a test: a Twenty release that rewords its errors
    // turns this check off rather than turning it into false accusations.
    for (const message of [
      'FetchError: request to http://localhost:3000/graphql failed',
      'Error: Unauthorized',
      'Error: seniorityLevel exploded',
      '',
    ]) {
      expect(classifyProbeRejection('seniorityLevel', message)).toBe(
        'inconclusive',
      );
    }
  });
});

describe('describeFieldMappingFindings', () => {
  it('should say nothing when there is nothing to say', () => {
    expect(describeFieldMappingFindings([], 'Person')).toBeNull();
  });

  it('should name the field, the setting and what it costs', () => {
    const notice = describeFieldMappingFindings(
      [{ name: 'jobTitl', source: 'decisionMakerFieldName' }],
      'Person',
    );

    expect(notice).toBe(
      'Greenlight’s field mapping names a field Person does not have, so this ' +
        'backfill reads it as empty on every lead. “jobTitl” (Decision-maker ' +
        'field) is not a field on Person — Greenlight falls back to jobTitle, ' +
        'title and role, so a lead whose seniority is recorded only in that ' +
        'column is scored as though it had no job title. Correct the name on ' +
        'the Greenlight Configuration record, then run a backfill over all ' +
        'records to re-score what this run has already done.',
    );
  });

  it('should say what a missing opt-out column costs, which is compliance', () => {
    const notice =
      describeFieldMappingFindings(
        [{ name: 'gdprOptOut', source: 'optOutFieldNames' }],
        'Person',
      ) ?? '';

    expect(notice).toContain('“gdprOptOut” (Opt-out fields)');
    expect(notice).toContain(
      'optedOut, doNotContact, emailOptOut and unsubscribed',
    );
    expect(notice).toContain(
      'is not recognised as opted out and can be released for outreach',
    );
  });

  it('should not overstate a setting no rule reads yet', () => {
    const notice =
      describeFieldMappingFindings(
        [{ name: 'leadStatus', source: 'readyForOutreachFieldName' }],
        'Person',
      ) ?? '';

    expect(notice).toContain('no rule reads that setting in this release');
    expect(notice).toContain('no score changes');
  });

  it('should count when more than one name is missing', () => {
    const notice =
      describeFieldMappingFindings(
        [
          { name: 'jobTitl', source: 'decisionMakerFieldName' },
          { name: 'gdprOptOut', source: 'optOutFieldNames' },
        ],
        'Person',
      ) ?? '';

    expect(notice).toContain('names 2 fields Person does not have');
    expect(notice).toContain('“jobTitl”');
    expect(notice).toContain('“gdprOptOut”');
  });

  it('should never blame the person reading it', () => {
    const notice =
      describeFieldMappingFindings(
        [{ name: 'jobTitl', source: 'decisionMakerFieldName' }],
        'Person',
      ) ?? '';

    for (const word of ['typo', 'invalid', 'you ', 'your ', 'mistake', 'wrong']) {
      expect(notice.toLowerCase()).not.toContain(word);
    }
  });
});

describe('the audit row', () => {
  it('should name the field when there is one, and count when there are more', () => {
    expect(
      fieldMappingAuditName(
        [{ name: 'jobTitl', source: 'decisionMakerFieldName' }],
        'Person',
      ),
    ).toBe('ERROR · Greenlight field mapping · “jobTitl” is not a field on Person');

    expect(
      fieldMappingAuditName(
        [
          { name: 'jobTitl', source: 'decisionMakerFieldName' },
          { name: 'gdprOptOut', source: 'optOutFieldNames' },
        ],
        'Person',
      ),
    ).toBe(
      'ERROR · Greenlight field mapping · 2 configured names are not fields on Person',
    );
  });

  it('should carry the logical key and what is left to read', () => {
    expect(
      fieldMappingAuditDetail(
        {
          missing: [{ name: 'jobTitl', source: 'decisionMakerFieldName' }],
          probed: 3,
          inconclusive: 1,
          unchecked: 2,
        },
        'person',
      ),
    ).toEqual({
      action: 'field_mapping_check',
      leadObjectNameSingular: 'person',
      missing: [
        {
          name: 'jobTitl',
          setting: 'decisionMakerFieldName',
          settingLabel: 'Decision-maker field',
          logicalKey: 'jobTitle',
          remainingCandidates: ['jobTitle', 'title', 'role'],
        },
      ],
      probed: 3,
      inconclusive: 1,
      unchecked: 2,
    });
  });
});
