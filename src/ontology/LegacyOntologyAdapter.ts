/**
 * LegacyOntologyAdapter - Bridges km-core's OntologyRegistry to the legacy
 * OntologyManager API.
 *
 * Phase 42-03 deleted the legacy JSON-file-loading ontology class. The
 * ontology-classification-agent now constructs km-core's `OntologyRegistry`
 * (single-level directory walk + atomic reload) directly and wraps it in this
 * adapter so that `OntologyValidator` and `OntologyClassifier` — which are
 * typed against `OntologyManager` — keep working unchanged.
 *
 * `OntologyManager` carries private fields, so TypeScript only accepts a
 * subclass where an `OntologyManager` is expected. This adapter therefore
 * extends `OntologyManager` and overrides every data-access method to read
 * from the wrapped registry instead of the (never-loaded) JSON-file state.
 *
 * km-core's registry resolves `extends` + property/relationship merging at
 * load time, so `getClass()` already returns fully-merged classes; this
 * adapter only has to translate the km-core `ResolvedClass` shape into the
 * legacy `ResolvedEntityDefinition` shape.
 */

import { OntologyRegistry } from '@fwornle/km-core';
import { OntologyManager, ResolvedEntityDefinition } from './OntologyManager.js';
import {
  PropertyDefinition,
  PropertyType,
  EntityResolutionError,
} from './types.js';

/** km-core's resolved-class shape, derived from the registry's public method. */
type ResolvedClass = NonNullable<ReturnType<OntologyRegistry['getClass']>>;

const VALID_PROPERTY_TYPES: ReadonlySet<string> = new Set<PropertyType>([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'reference',
]);

export class LegacyOntologyAdapter extends OntologyManager {
  constructor(private readonly registry: OntologyRegistry) {
    // The base never loads JSON files (initialize() is never invoked on the
    // adapter), so a minimal config is sufficient to satisfy the constructor.
    super({ enabled: true, upperOntologyPath: '' });
  }

  /**
   * Re-scan the ontology directory and rebuild the class catalog atomically.
   */
  async reload(): Promise<void> {
    await this.registry.reload();
  }

  /**
   * Check whether an entity class exists in the resolved catalog.
   */
  hasEntityClass(entityClass: string, _team?: string): boolean {
    return this.registry.isValidClass(entityClass);
  }

  /**
   * Get all entity class names, optionally scoped to a team's lower ontology
   * plus the shared upper ontology. `_comment_` keys are excluded.
   */
  getAllEntityClasses(team?: string): string[] {
    const names: string[] = [];
    for (const [name, cls] of this.registry.classCatalog) {
      if (name.startsWith('_comment_')) continue;
      if (team && cls.source !== 'upper' && cls.source !== team) continue;
      names.push(name);
    }
    return names.sort();
  }

  /**
   * Resolve an entity definition. km-core has already merged the inheritance
   * chain, so this maps the resolved class into the legacy shape and rebuilds
   * the inheritance chain from the registry's parent-chain accessor.
   */
  resolveEntityDefinition(
    entityClass: string,
    team?: string,
  ): ResolvedEntityDefinition {
    const cls = this.registry.getClass(entityClass);
    if (!cls) {
      throw new EntityResolutionError(
        `Entity class '${entityClass}' not found in ${team ? `team '${team}'` : 'any ontology'}`,
        entityClass,
        { team },
      );
    }

    const { properties, requiredProperties } = this.mapProperties(cls);

    // Root-first inheritance chain: [...ancestors (root first), self].
    const ancestors = this.registry
      .parentChainOf(entityClass)
      .map((parent) => parent.name)
      .reverse();
    const inheritanceChain = [...ancestors, entityClass];

    return {
      description: cls.description,
      properties,
      requiredProperties,
      extendsEntity: cls.extends,
      team: cls.source !== 'upper' ? cls.source : undefined,
      ontologyType: cls.source === 'upper' ? 'upper' : 'lower',
      inheritanceChain,
    };
  }

  /**
   * Statistics over the resolved catalog.
   */
  getStatistics(team?: string): {
    upperEntities: number;
    lowerEntities: number;
    totalEntities: number;
    relationships: number;
    teams: string[];
  } {
    let upperEntities = 0;
    let lowerEntities = 0;
    let relationships = 0;
    const teams = new Set<string>();

    for (const [name, cls] of this.registry.classCatalog) {
      if (name.startsWith('_comment_')) continue;
      relationships += Object.keys(cls.relationships ?? {}).length;
      if (cls.source === 'upper') {
        upperEntities += 1;
      } else {
        teams.add(cls.source);
        if (!team || cls.source === team) {
          lowerEntities += 1;
        }
      }
    }

    return {
      upperEntities,
      lowerEntities,
      totalEntities: upperEntities + lowerEntities,
      relationships,
      teams: Array.from(teams).sort(),
    };
  }

  /**
   * Translate a km-core resolved class's properties into the legacy
   * `PropertyDefinition` map and derive the required-property list.
   */
  private mapProperties(cls: ResolvedClass): {
    properties: Record<string, PropertyDefinition>;
    requiredProperties: string[];
  } {
    const properties: Record<string, PropertyDefinition> = {};
    const requiredProperties: string[] = [];

    for (const [propName, propDef] of Object.entries(cls.properties ?? {})) {
      const type: PropertyType = VALID_PROPERTY_TYPES.has(propDef.type)
        ? (propDef.type as PropertyType)
        : 'string';

      const mapped: PropertyDefinition = { type };
      if (propDef.required !== undefined) mapped.required = propDef.required;
      if (propDef.enum !== undefined) mapped.enum = propDef.enum;
      properties[propName] = mapped;

      if (propDef.required) requiredProperties.push(propName);
    }

    return { properties, requiredProperties };
  }
}
