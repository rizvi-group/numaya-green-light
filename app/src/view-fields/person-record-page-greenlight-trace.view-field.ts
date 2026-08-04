import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS,
  PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/universal-identifiers';

/**
 * The rule trace, in System.
 *
 * It is raw JSON and no rep needs it day to day, which is exactly the argument
 * for System rather than for leaving it off the page: System is where Twenty
 * already keeps the fields you go looking for only when something is wrong, and
 * "why did Greenlight score this 39.8" is that kind of question. Hiding the
 * trace entirely is how a scoring product becomes unarguable-with.
 */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightTrace,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.system.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightTrace,
  position: 100,
  isVisible: true,
  size: 150,
});
