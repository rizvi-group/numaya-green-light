import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';

import { describe, expect, it } from 'vitest';

/**
 * Every relation must be two fields that name each other — the check the
 * Twenty server runs and this app once shipped without.
 *
 * ## What happened in 0.2.5
 *
 * The sales-team objects declared six MANY_TO_ONE relations whose inverse
 * ONE_TO_MANY fields were referenced by uuid but never declared anywhere in
 * the manifest. The local build does not validate reciprocals, so the package
 * published clean; the server's metadata sync (v2.29,
 * `validateMorphOrRelationFlatFieldMetadata`) resolved each reciprocal in
 * "existing or about to be created field metadatas", found nothing, and failed
 * the whole install with `FIELD_METADATA_NOT_FOUND` — leaving the workspace
 * half-upgraded (application row 0.2.5, object metadata 0.2.4).
 *
 * ## Why this test discovers its inputs
 *
 * Same reasoning as `identifier-uniqueness.test.ts`: an invariant expressed as
 * a hand-written list of objects holds only until somebody adds a file and
 * forgets the list. `import.meta.glob` over `src/objects` and `src/fields`
 * covers a new relation by the act of declaring it.
 *
 * ## What is asserted
 *
 * For every RELATION field, in objects and in top-level field files alike:
 *   - the uuid it names in `relationTargetFieldMetadataUniversalIdentifier`
 *     is itself a declared field of this app (the exact server check);
 *   - that reciprocal names this field back (the pair cross-references, not
 *     just resolves — a one-sided resolve would silently pass a dangling
 *     reference on the other side);
 *   - the reciprocal is owned by the object this field points at;
 *   - one side is MANY_TO_ONE and the other ONE_TO_MANY.
 */

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { eager: true },
    ) => Record<string, Record<string, unknown>>;
  }
}

type FieldConfig = {
  universalIdentifier: string;
  name: string;
  type: string;
  relationTargetObjectMetadataUniversalIdentifier?: string;
  relationTargetFieldMetadataUniversalIdentifier?: string;
  universalSettings?: { relationType?: string };
};

type Field = FieldConfig & { ownerObjectUniversalIdentifier: string; path: string };

const objectModulesRaw = import.meta.glob('../*.ts', { eager: true });
const fieldModulesRaw = import.meta.glob('../../fields/*.field.ts', {
  eager: true,
});

type ValidationResult<T> = { success: boolean; config: T; errors: string[] };

const asConfig = (module: Record<string, unknown>, path: string) => {
  const exported = module.default as ValidationResult<Record<string, unknown>>;

  if (!exported || typeof exported !== 'object' || !('config' in exported)) {
    throw new Error(`${path} does not default-export a define*() result`);
  }

  return exported.config;
};

const objectEntries = Object.entries(objectModulesRaw).filter(
  ([path]) => !path.includes('__tests__'),
);

/** object uuid -> readable name, for messages and target-object checks. */
const objectsByUuid = new Map<string, string>();

for (const [path, module] of objectEntries) {
  const config = asConfig(module, path) as {
    universalIdentifier: string;
    nameSingular: string;
  };

  objectsByUuid.set(config.universalIdentifier, config.nameSingular);
}

// A relation may point at a core Twenty object (workspaceMember, person, …).
// Those are not declared by this app, but they are valid targets — the check
// is that the *reciprocal field* is declared, and for core objects that means
// a top-level field file in src/fields/.
for (const [name, standard] of Object.entries(
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
) as [string, { universalIdentifier: string }][]) {
  objectsByUuid.set(standard.universalIdentifier, name);
}

const declared: Field[] = [];

for (const [path, module] of objectEntries) {
  const config = asConfig(module, path) as {
    universalIdentifier: string;
    fields?: FieldConfig[];
  };

  for (const field of config.fields ?? []) {
    declared.push({
      ...field,
      ownerObjectUniversalIdentifier: config.universalIdentifier,
      path,
    });
  }
}

for (const [path, module] of Object.entries(fieldModulesRaw)) {
  const config = asConfig(module, path) as FieldConfig & {
    objectUniversalIdentifier: string;
  };

  declared.push({
    ...config,
    ownerObjectUniversalIdentifier: config.objectUniversalIdentifier,
    path,
  });
}

const fieldsByUuid = new Map(
  declared.map((field) => [field.universalIdentifier, field]),
);

const relations = declared.filter((field) => field.type === 'RELATION');

describe('relation fields, across every object and field file', () => {
  it('should have discovered objects and fields', () => {
    // Floors rather than exact counts, for the same reason as the identifier
    // guard: a discovery regression must fail loudly, a legitimate addition
    // must not.
    expect(objectsByUuid.size).toBeGreaterThan(3);
    expect(relations.length).toBeGreaterThanOrEqual(6);
  });

  it('should declare a reciprocal for every relation, cross-referencing back', () => {
    const problems: string[] = [];

    for (const field of relations) {
      const described = `${field.path} → ${field.name} (${field.universalIdentifier})`;
      const targetUuid = field.relationTargetFieldMetadataUniversalIdentifier;
      const targetObjectUuid =
        field.relationTargetObjectMetadataUniversalIdentifier;

      if (!targetUuid || !targetObjectUuid) {
        problems.push(
          `${described}: relation without relationTarget* universal identifiers`,
        );
        continue;
      }

      if (!objectsByUuid.has(targetObjectUuid)) {
        problems.push(
          `${described}: targets object ${targetObjectUuid}, which this app does not declare`,
        );
        continue;
      }

      const reciprocal = fieldsByUuid.get(targetUuid);

      if (!reciprocal) {
        // The exact 0.2.5 failure: the reciprocal uuid is named but never
        // declared, which the server reports as FIELD_METADATA_NOT_FOUND.
        problems.push(
          `${described}: reciprocal ${targetUuid} is not declared by any object or field file`,
        );
        continue;
      }

      if (
        reciprocal.relationTargetFieldMetadataUniversalIdentifier !==
        field.universalIdentifier
      ) {
        problems.push(
          `${described}: reciprocal ${reciprocal.name} (${reciprocal.universalIdentifier}) does not name this field back`,
        );
      }

      if (reciprocal.ownerObjectUniversalIdentifier !== targetObjectUuid) {
        problems.push(
          `${described}: reciprocal ${reciprocal.name} is owned by ${reciprocal.ownerObjectUniversalIdentifier}, not by the target object ${targetObjectUuid}`,
        );
      }

      const ownType = field.universalSettings?.relationType;
      const reciprocalType = reciprocal.universalSettings?.relationType;
      const complementary =
        (ownType === 'MANY_TO_ONE' && reciprocalType === 'ONE_TO_MANY') ||
        (ownType === 'ONE_TO_MANY' && reciprocalType === 'MANY_TO_ONE');

      if (!complementary) {
        problems.push(
          `${described}: relationType ${ownType ?? 'unset'} faces ${reciprocalType ?? 'unset'} on the reciprocal`,
        );
      }
    }

    expect(problems).toEqual([]);
  });
});
