/** Type declarations for @local/km-core. */

export interface Entity {
    id: string;
    name: string;
    ontologyClass?: string;
    entityType?: string;
    description?: string;
    observations?: string[];
    embedding?: number[];
    metadata?: Record<string, unknown>;
    team?: string;
    validFrom?: string;
    validUntil?: string | null;
    [key: string]: unknown;
}

export interface Relation {
    id: string;
    from: string;
    to: string;
    type: string;
    metadata?: Record<string, unknown>;
    validFrom?: string;
}

export interface Project {
    name: string;
    [key: string]: unknown;
}

export interface ResolvedOntologyClass {
    name: string;
    description: string;
    properties: Record<string, unknown>;
    requiredProperties: string[];
    extends: string | null;
    relationships: Record<string, unknown>;
    source: string;
}

export declare class OntologyRegistry {
    ontologyDir: string;
    classCatalog: Map<string, ResolvedOntologyClass>;
    constructor(opts?: { ontologyDir?: string });
    reload(): Promise<void>;
    getClass(name: string): ResolvedOntologyClass | undefined;
    isValidClass(name: string): boolean;
    parentChainOf(name: string): Array<{ name: string }>;
}

export interface GraphKMStoreOptions {
    dbPath?: string;
    exportDir?: string;
    ontologyDir?: string;
    domains?: string[];
    debounceMs?: number;
}

export type BatchOp =
    | { type: 'putEntity'; entity: Entity; opts?: Record<string, unknown> }
    | { type: 'deleteEntity'; id: string }
    | { type: 'addRelation'; relation: Relation }
    | { type: 'mergeAttributes'; id: string; attrs: Record<string, unknown> };

export declare class GraphKMStore {
    dbPath: string;
    exportDir: string;
    ontologyDir: string;
    domains: string[];
    ontology: OntologyRegistry;
    graph: { entities: Map<string, Entity>; relations: Relation[] } | null;
    constructor(opts?: GraphKMStoreOptions);
    open(): Promise<void>;
    close(): Promise<void>;
    putEntity(entity: Entity, opts?: Record<string, unknown>): Promise<string>;
    mergeAttributes(id: string, attrs: Record<string, unknown>): Promise<Entity>;
    addRelation(relation: Relation): Promise<Relation>;
    iterate(
        filter?: (e: Entity) => boolean,
        opts?: { includeSuperseded?: boolean },
    ): AsyncGenerator<Entity>;
    findByOntologyClass(cls: string): Promise<Entity[]>;
    findRelations(match?: { from?: string; to?: string; type?: string }): Promise<Relation[]>;
    batch(ops: BatchOp[]): Promise<void>;
    exportSnapshot(): Promise<string>;
}

export interface RouterLike {
    get?(path: string, handler: (req: any, res: any) => void): RouterLike;
    post?(path: string, handler: (req: any, res: any) => void): RouterLike;
    delete?(path: string, handler: (req: any, res: any) => void): RouterLike;
    use?(handler: (req: any, res: any, next: () => void) => void): RouterLike;
}

export interface KmCoreRouterOpts {
    ontologyRegistry?: OntologyRegistry;
    snapshotDir?: string;
    restartCommand?: string;
}

export declare function createKmCoreRouter(
    store: GraphKMStore,
    router: RouterLike,
    opts?: KmCoreRouterOpts,
): RouterLike;

export declare function mintEntityId(): string;
export declare function isProject(value: unknown): value is string;
export declare function mergeEntities(a: Entity | undefined, b: Entity | undefined): Entity | undefined;
export declare function mergeEntities(
    store: GraphKMStore,
    survivorId: string,
    duplicateIds: Array<string | Entity>,
    opts?: { provenance?: Record<string, unknown> },
): Entity;
export declare function mergeDescriptionSegment(current: string | undefined, segment: string | undefined): string;
export declare function mergeDescriptionSegment(entity: Entity, segment: DescriptionSegment): Entity;

export type EntityId = string;

export interface DescriptionSegment {
    text: string;
    runId?: string;
    provider?: string;
    model?: string;
    quality?: string;
    timestamp?: string;
    confirmations?: unknown[];
}
export declare function getHierarchyRoots(): string[];
export declare function getHierarchyRootClass(): Record<string, string>;
export declare function isHierarchyRoot(name: unknown): boolean;

export const HIERARCHY_ROOTS: string[];
export const HIERARCHY_ROOT_CLASS: Record<string, string>;

export type ResolvedClass = ResolvedOntologyClass;
