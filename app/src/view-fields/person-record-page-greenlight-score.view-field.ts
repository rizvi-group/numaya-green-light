import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS,
  PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/universal-identifiers';

/**
 * The score, on the record page, in the section a rep already reads.
 *
 * `defineField` gave Person a `greenlightScore` column in the database and in
 * the API. It did not put it on the record page: that panel renders the
 * "Person Record Page Fields" view, and a field that is not a view field on that
 * view is simply not drawn. This file is what makes the number visible.
 *
 * See `PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS` for why the section
 * is one of Twenty's own and not a Greenlight one, and why positions start at
 * 100.
 */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.general.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
  position: 100,
  isVisible: true,
  size: 150,
});
