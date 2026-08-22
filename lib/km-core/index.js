/**
 * @local/km-core — self-contained knowledge-management core.
 *
 * Implements the API surface consumed by this repository:
 *   GraphKMStore, OntologyRegistry, createKmCoreRouter,
 *   Entity/Relation/Project/GraphKMStore types (JSDoc),
 *   mintEntityId, mergeEntities, mergeDescriptionSegment, isProject,
 *   HIERARCHY_ROOTS, HIERARCHY_ROOT_CLASS, isHierarchyRoot
 *
 * Storage: JSON snapshot inside `dbPath` with debounced flushes — no native
 * dependencies. Ontology: JSON files under `<ontologyDir>/upper` and
 * `<ontologyDir>/lower`.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Hierarchy roots
// ---------------------------------------------------------------------------

const DEFAULT_HIERARCHY_ROOTS = [
    'File', 'Service', 'Feature', 'Contract', 'RuntimeDiagnostics',
    'StaticDiagnostics', 'Port', 'Config', 'Container', 'Process',
    'Fault', 'Limitation', 'Revision',
];

let _hierarchyRoots = null;
let _hierarchyRootClass = null;

function ontologyDirForDefaults() {
    const repo =
        process.env.REPOSITORY_PATH ||
        process.env.CODING_REPO ||
        process.cwd();
    return path.join(repo, '.data', 'ontologies');
}

/**
 * Root classes of the upper ontology, discovered from the upper ontology
 * file when available; falls back to the static list above.
 */
export function getHierarchyRoots() {
    if (_hierarchyRoots) return _hierarchyRoots;
    try {
        const dir = path.join(ontologyDirForDefaults(), 'upper');
        const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
        if (file) {
            const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            const ents = doc.entities || {};
            const roots = Object.entries(ents)
                .filter(([, v]) => v && !v.extendsEntity)
                .map(([k]) => k);
            if (roots.length) {
                _hierarchyRoots = roots;
                _hierarchyRootClass = null; // rebuild map lazily
                return _hierarchyRoots;
            }
        }
    } catch {
        /* fall through to defaults */
    }
    _hierarchyRoots = [...DEFAULT_HIERARCHY_ROOTS];
    return _hierarchyRoots;
}

/** Map of root observation name → canonical locked ontology class. */
export function getHierarchyRootClass() {
    if (_hierarchyRootClass) return _hierarchyRootClass;
    const map = {};
    for (const root of getHierarchyRoots()) map[root] = root;
    _hierarchyRootClass = map;
    return _hierarchyRootClass;
}

export function isHierarchyRoot(name) {
    if (!name || typeof name !== 'string') return false;
    return Object.prototype.hasOwnProperty.call(getHierarchyRootClass(), name);
}

// Backwards-compatible live bindings via getters cannot be plain exports;
// expose the arrays as frozen snapshots refreshed on access through the
// functions above while also exporting static views for importers that
// destructure at module load time.
export const HIERARCHY_ROOTS = new Proxy([], {
    ownTarget: null,
    get(_t, prop) {
        return Reflect.get(getHierarchyRoots(), prop);
    },
});
export const HIERARCHY_ROOT_CLASS = new Proxy({}, {
    get(_t, prop) {
        return Reflect.get(getHierarchyRootClass(), prop);
    },
});

// ---------------------------------------------------------------------------
// ID minting + entity helpers
// ---------------------------------------------------------------------------

/** UUIDv7-style id: 48-bit ms timestamp + 74 random bits, RFC-4566 layout. */
export function mintEntityId() {
    const ts = Date.now();
    const rand = crypto.randomBytes(10);
    const hex = ts.toString(16).padStart(12, '0');
    const b = [...rand];
    // 12 hex chars (time) + '-' + version7 nibble + rest, standard layout
    const tail = b.map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
    void tail;
    const buf = Buffer.concat([Buffer.from(hex, 'hex'), rand]);
    buf[6] = (buf[6] & 0x0f) | 0x70; // version 7
    buf[8] = (buf[8] & 0x3f) | 0x80; // variant
    const s = buf.toString('hex');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const DEFAULT_PROJECTS = (process.env.KM_PROJECTS || 'coding,ui,resi,raas')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** True when `value` names a known project/domain tag. */
export function isProject(value) {
    if (typeof value !== 'string' || !value) return false;
    if (DEFAULT_PROJECTS.includes(value)) return true;
    try {
        const store = GraphKMStore.__lastInstance;
        if (store?.domains) return store.domains.includes(value);
    } catch {
        /* ignore */
    }
    return false;
}

/**
 * Two forms:
 *   mergeEntities(entityA, entityB)            → merged fresh object
 *   mergeEntities(store, survivorId, dupIds[], opts) → fold duplicates into
 *       the surviving entity inside the store and delete the duplicates.
 */
export function mergeEntities(a, b, extraOrDupIds, maybeOpts) {
    // Store form
    if (a instanceof GraphKMStore && typeof b === 'string') {
        const store = a;
        const survivorId = b;
        const dupIds = Array.isArray(extraOrDupIds)
            ? extraOrDupIds
            : [extraOrDupIds].filter(Boolean);
        const opts = maybeOpts || {};
        const survivor = store.entities.get(survivorId);
        if (!survivor) throw new Error(`km-core.mergeEntities: survivor '${survivorId}' not found`);
        const folded = [];
        for (const dupId of dupIds) {
            const dup = typeof dupId === 'string'
                ? store.entities.get(dupId) ||
                  [...store.entities.values()].find(
                      (e) => e.name?.toLowerCase() === String(dupId).toLowerCase(),
                  )
                : dupId;
            if (!dup || dup.id === survivor.id) continue;
            folded.push(dup);
        }
        const merged = folded.reduce((acc, dup) => mergeEntities(acc, dup), survivor);
        merged.updatedAt = new Date().toISOString();
        if (opts.provenance) {
            metadataPush(merged, 'mergeProvenance', opts.provenance);
        }
        for (const dup of folded) {
            store.entities.delete(dup.id);
            store.relations = store.relations.map((r) => ({
                ...r,
                from: r.from === dup.id ? survivor.id : r.from,
                to: r.to === dup.id ? survivor.id : r.to,
            }));
        }
        store.entities.set(survivor.id, merged);
        store._scheduleFlush();
        return merged;
    }

    // Object form
    if (!a) return b ? structuredClone(b) : undefined;
    if (!b) return structuredClone(a);
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
        const cur = out[k];
        if (cur === undefined || cur === null || cur === '') out[k] = v;
        else if (k === 'metadata' && typeof v === 'object' && v)
            out[k] = { ...(cur || {}), ...v };
    }
    return out;
}

function metadataPush(entity, key, value) {
    const md = { ...(entity.metadata || {}) };
    md[key] = [...(Array.isArray(md[key]) ? md[key] : []), value];
    entity.metadata = md;
}

/**
 * Fold a DescriptionSegment into an entity and return a NEW entity.
 * Appends `segment.text` to `description` (deduped) and records the segment
 * under `metadata.descriptionSegments`. Accepts a legacy string `current`
 * (returns the merged description string) for older callers.
 */
export function mergeDescriptionSegment(current, segment) {
    // Legacy string form: (currentDescription, segmentText)
    if (typeof current === 'string' || typeof segment === 'string') {
        const base = typeof current === 'string' ? current : '';
        const add = typeof segment === 'string' ? segment.trim() : '';
        if (!add) return base;
        if (base.includes(add)) return base;
        return base ? `${base}\n${add}` : add;
    }
    const entity = current && typeof current === 'object' ? current : {};
    const seg = segment && typeof segment === 'object' ? segment : { text: String(segment ?? '') };
    const prevDesc = typeof entity.description === 'string' ? entity.description : '';
    const text = typeof seg.text === 'string' ? seg.text.trim() : '';
    const description =
        !text ? prevDesc : prevDesc.includes(text) ? prevDesc : prevDesc ? `${prevDesc}\n\n${text}` : text;
    const metadata = { ...(entity.metadata || {}) };
    const segments = Array.isArray(metadata.descriptionSegments)
        ? [...metadata.descriptionSegments, seg]
        : [seg];
    metadata.descriptionSegments = segments;
    return { ...entity, description, metadata };
}

// ---------------------------------------------------------------------------
// OntologyRegistry
// ---------------------------------------------------------------------------

export class OntologyRegistry {
    /** @param {{ontologyDir: string}} opts */
    constructor(opts) {
        this.ontologyDir = opts?.ontologyDir || path.join(process.cwd(), '.data', 'ontologies');
        this.classCatalog = new Map();
        this.sources = new Map(); // source → file path
    }

    async reload() {
        this.classCatalog.clear();
        this.sources.clear();
        const upperDir = path.join(this.ontologyDir, 'upper');
        const lowerDir = path.join(this.ontologyDir, 'lower');

        const loadDoc = (file, source) => {
            let doc;
            try {
                doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch {
                return;
            }
            this.sources.set(source, file);
            const entities = doc.entities || {};
            for (const [name, def] of Object.entries(entities)) {
                if (!def || typeof def !== 'object') continue;
                this.classCatalog.set(name, {
                    name,
                    description: def.description || '',
                    properties: def.properties || {},
                    requiredProperties: def.requiredProperties || [],
                    extends: def.extendsEntity || null,
                    relationships: def.relationships || {},
                    source,
                });
            }
        };

        if (fs.existsSync(upperDir)) {
            for (const f of fs.readdirSync(upperDir)) {
                if (f.endsWith('.json')) loadDoc(path.join(upperDir, f), 'upper');
            }
        }
        if (fs.existsSync(lowerDir)) {
            for (const f of fs.readdirSync(lowerDir)) {
                if (!f.endsWith('.json')) continue;
                let team = f.replace(/-ontology\.json$/, '').replace(/\.json$/, '');
                try {
                    const doc = JSON.parse(fs.readFileSync(path.join(lowerDir, f), 'utf8'));
                    if (doc.team) team = doc.team;
                } catch {
                    /* keep filename-derived team */
                }
                loadDoc(path.join(lowerDir, f), team);
            }
        }

        // Resolve inheritance: fold parent properties down (child wins).
        const resolve = (name, seen = new Set()) => {
            if (seen.has(name)) return this.classCatalog.get(name);
            seen.add(name);
            const cls = this.classCatalog.get(name);
            if (!cls) return undefined;
            if (cls.extends && this.classCatalog.has(cls.extends)) {
                const parent = resolve(cls.extends, seen);
                if (parent) {
                    cls.properties = { ...(parent.properties || {}), ...(cls.properties || {}) };
                    cls.requiredProperties = [
                        ...new Set([...(parent.requiredProperties || []), ...(cls.requiredProperties || [])]),
                    ];
                    cls.relationships = { ...(parent.relationships || {}), ...(cls.relationships || {}) };
                    if (!cls.description) cls.description = parent.description;
                }
            }
            return cls;
        };
        for (const name of [...this.classCatalog.keys()]) resolve(name);
    }

    getClass(name) {
        return this.classCatalog.get(name);
    }

    isValidClass(name) {
        return this.classCatalog.has(name);
    }

    /** Chain from `name` up to its root, self first: [self, parent, ..., root]. */
    parentChainOf(name) {
        const chain = [];
        let cur = this.classCatalog.get(name);
        const seen = new Set();
        while (cur && !seen.has(cur.name)) {
            seen.add(cur.name);
            chain.push({ name: cur.name });
            cur = cur.extends ? this.classCatalog.get(cur.extends) : undefined;
        }
        return chain;
    }
}

// ---------------------------------------------------------------------------
// GraphKMStore
// ---------------------------------------------------------------------------

export class GraphKMStore {
    /**
     * @param {{dbPath?: string, exportDir?: string, ontologyDir?: string,
     *          domains?: string[], debounceMs?: number}} opts
     */
    constructor(opts = {}) {
        this.dbPath = opts.dbPath || path.join(process.cwd(), '.data', 'knowledge-graph', 'leveldb');
        this.exportDir = opts.exportDir || path.join(process.cwd(), '.data', 'knowledge-graph', 'exports');
        this.ontologyDir = opts.ontologyDir || path.join(process.cwd(), '.data', 'ontologies');
        this.domains = opts.domains || ['coding'];
        this.debounceMs = opts.debounceMs ?? 5000;

        this.entities = new Map(); // id → entity
        this.relations = [];       // {id, from, to, type, metadata}
        this.graph = null;         // set by open()
        this.ontology = new OntologyRegistry({ ontologyDir: this.ontologyDir });

        this._flushTimer = null;
        GraphKMStore.__lastInstance = this;
    }

    get snapshotFile() {
        return path.join(this.dbPath, 'graph.json');
    }

    async open() {
        fs.mkdirSync(this.dbPath, { recursive: true });
        fs.mkdirSync(this.exportDir, { recursive: true });
        await this.ontology.reload();

        if (fs.existsSync(this.snapshotFile)) {
            try {
                const raw = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
                for (const e of raw.entities || []) this.entities.set(e.id, e);
                this.relations = raw.relations || [];
            } catch (err) {
                console.warn('[km-core] snapshot unreadable, starting empty:', err.message);
            }
        }
        this.graph = { entities: this.entities, relations: this.relations };
    }

    async close() {
        this._flushNow();
    }

    _scheduleFlush() {
        if (this._flushTimer) return;
        this._flushTimer = setTimeout(() => this._flushNow(), Math.max(250, this.debounceMs));
        if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
    }

    _flushNow() {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        try {
            fs.mkdirSync(this.dbPath, { recursive: true });
            fs.writeFileSync(
                this.snapshotFile,
                JSON.stringify({ entities: [...this.entities.values()], relations: this.relations }, null, 1),
            );
        } catch (err) {
            console.warn('[km-core] flush failed:', err.message);
        }
    }

    /** Upsert an entity; returns its (possibly minted) id. */
    async putEntity(entity, _opts = {}) {
        if (!entity || typeof entity !== 'object') throw new TypeError('putEntity: entity required');
        if (!entity.id) entity.id = mintEntityId();
        if (!entity.validFrom) entity.validFrom = new Date().toISOString();
        const prev = this.entities.get(entity.id);
        this.entities.set(entity.id, prev ? mergeEntities(prev, entity) : entity);
        this._scheduleFlush();
        return entity.id;
    }

    /** Shallow-merge attributes onto an existing entity. */
    async mergeAttributes(id, attrs) {
        const e = this.entities.get(id);
        if (!e) throw new Error(`km-core.mergeAttributes: entity not found '${id}'`);
        Object.assign(e, attrs);
        this._scheduleFlush();
        return e;
    }

    /** Add a relation `{from, to, type, metadata?}` (ids or names). */
    async addRelation(rel) {
        if (!rel?.from || !rel?.to || !rel?.type) throw new TypeError('addRelation: from/to/type required');
        const key = `${rel.from}|${rel.to}|${rel.type}`;
        if (this.relations.some((r) => `${r.from}|${r.to}|${r.type}` === key)) return rel;
        const full = {
            id: rel.id || mintEntityId(),
            ...rel,
            validFrom: rel.validFrom || new Date().toISOString(),
        };
        this.relations.push(full);
        this._scheduleFlush();
        return full;
    }

    /** Async iterable over entities (optionally filtered); supports superseded. */
    async *iterate(filter, opts = {}) {
        const includeSuperseded = opts.includeSuperseded ?? true;
        for (const e of this.entities.values()) {
            if (!includeSuperseded && e.validUntil) continue;
            if (filter && !filter(e)) continue;
            yield e;
        }
    }

    /** Entities whose ontologyClass or entityType matches `cls`. */
    async findByOntologyClass(cls) {
        const out = [];
        for (const e of this.entities.values()) {
            if (e.ontologyClass === cls || e.entityType === cls) out.push(e);
        }
        return out;
    }

    /** Relations matching {from?, to?, type?} — ids or names accepted. */
    async findRelations(match = {}) {
        const resolveName = (idOrName) => {
            const e = this.entities.get(idOrName);
            return e ? e.name : idOrName;
        };
        return this.relations.filter((r) => {
            if (match.from) {
                const f = resolveName(match.from);
                if (r.from !== match.from && r.from !== f) return false;
            }
            if (match.to) {
                const t = resolveName(match.to);
                if (r.to !== match.to && r.to !== t) return false;
            }
            if (match.type && r.type !== match.type) return false;
            return true;
        });
    }

    /**
     * Apply a batch of operations:
     *   {type:'putEntity', entity} | {type:'deleteEntity', id}
     *   {type:'addRelation', relation} | {type:'mergeAttributes', id, attrs}
     */
    async batch(ops) {
        for (const op of ops || []) {
            switch (op.type) {
                case 'putEntity':
                    await this.putEntity(op.entity, op.opts);
                    break;
                case 'deleteEntity': {
                    this.entities.delete(op.id);
                    this.relations = this.relations.filter(
                        (r) => r.from !== op.id && r.to !== op.id,
                    );
                    break;
                }
                case 'addRelation':
                    await this.addRelation(op.relation);
                    break;
                case 'mergeAttributes':
                    await this.mergeAttributes(op.id, op.attrs);
                    break;
                default:
                    throw new Error(`km-core.batch: unknown op type '${op?.type}'`);
            }
        }
        this._scheduleFlush();
    }

    /** Write a JSON export of the current graph into `exportDir`. */
    async exportSnapshot() {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(this.exportDir, `knowledge-export-${stamp}.json`);
        fs.mkdirSync(this.exportDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            exportedAt: new Date().toISOString(),
            entities: [...this.entities.values()],
            relations: this.relations,
        }, null, 2));
        return file;
    }
}

// ---------------------------------------------------------------------------
// REST router factory
// ---------------------------------------------------------------------------

/**
 * Mount km-core's `/api/v1` routes onto a connect/express-like router.
 *
 * Routes:
 *   GET    /api/v1/entities?ontologyClass=&q=&limit=&offset=
 *   GET    /api/v1/entities/:id
 *   POST   /api/v1/entities
 *   DELETE /api/v1/entities/:id
 *   GET    /api/v1/relations?from=&to=&type=
 *   GET    /api/v1/stats
 *   GET    /api/v1/ontology/classes
 *   POST   /api/v1/snapshot
 */
export function createKmCoreRouter(store, router, opts = {}) {
    const json = (res, code, body) => {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
    };

    router.get?.('/entities', async (req, res) => {
        const { ontologyClass, q, limit, offset } = req.query ?? {};
        let candidates = ontologyClass
            ? await store.findByOntologyClass(ontologyClass)
            : [...store.entities.values()];
        let filtered = candidates;
        if (q) {
            const needle = String(q).toLowerCase();
            filtered = candidates.filter((e) =>
                (e.name || '').toLowerCase().includes(needle) ||
                (e.description || '').toLowerCase().includes(needle));
        }
        const total = filtered.length;
        const off = Number(offset) || 0;
        const lim = Number(limit) || 100;
        json(res, 200, { total, entities: filtered.slice(off, off + lim) });
    });

    router.get?.('/entities/:id', async (req, res) => {
        const e = store.entities.get(req.params.id);
        if (!e) return json(res, 404, { error: 'not found' });
        json(res, 200, e);
    });

    router.post?.('/entities', async (req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                const id = await store.putEntity(body);
                json(res, 201, { id });
            } catch (err) {
                json(res, 400, { error: err.message });
            }
        });
    });

    router.delete?.('/entities/:id', async (req, res) => {
        await store.batch([{ type: 'deleteEntity', id: req.params.id }]);
        json(res, 200, { ok: true });
    });

    router.get?.('/relations', async (req, res) => {
        const rels = await store.findRelations(req.query ?? {});
        json(res, 200, { total: rels.length, relations: rels });
    });

    router.get?.('/stats', async (_req, res) => {
        const classes = {};
        for await (const e of store.iterate()) {
            const c = e.ontologyClass || e.entityType || 'unclassified';
            classes[c] = (classes[c] || 0) + 1;
        }
        json(res, 200, {
            entities: store.entities.size,
            relations: store.relations.length,
            classes,
            ontologyClasses: store.ontology.classCatalog.size,
        });
    });

    router.get?.('/ontology/classes', async (_req, res) => {
        const registry = opts.ontologyRegistry || store.ontology;
        const out = [];
        for (const [name, cls] of registry.classCatalog) {
            out.push({
                name,
                source: cls.source,
                extends: cls.extends,
                description: cls.description,
            });
        }
        json(res, 200, { total: out.length, classes: out });
    });

    router.post?.('/snapshot', async (_req, res) => {
        try {
            const file = await store.exportSnapshot();
            json(res, 200, { ok: true, file, restartCommand: opts.restartCommand || null });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
    });

    return router;
}

// ---------------------------------------------------------------------------
// Type shims (documentation only — erased at runtime)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Entity
 * @property {string} id
 * @property {string} name
 * @property {string=} ontologyClass
 * @property {string=} entityType
 * @property {string=} description
 * @property {Object=} metadata
 * @property {string=} validFrom
 * @property {string|null=} validUntil
 */

/**
 * @typedef {Object} Relation
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string} type
 * @property {Object=} metadata
 */

/**
 * @typedef {Object} Project
 * @property {string} name
 */

/**
 * @typedef {Object} GraphKMStore
 * @see GraphKMStore
 */
