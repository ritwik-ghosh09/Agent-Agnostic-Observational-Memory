/**
 * GraphDatabaseService — self-contained knowledge-graph store.
 *
 * Persists entities + relations as a JSON snapshot under `dbPath`
 * (.data/knowledge-graph by default) with an in-memory index. Emits
 * 'change' events so exporters can sync .data/knowledge-export/*.json.
 *
 * Part of the local knowledge-management layer replacing the previously
 * unavailable upstream module set.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';

function mintId() {
    const buf = crypto.randomBytes(16);
    buf[6] = (buf[6] & 0x0f) | 0x70;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const s = buf.toString('hex');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export class GraphDatabaseService extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.dbPath = opts.dbPath || path.join(process.cwd(), '.data', 'knowledge-graph');
        this.config = { autoPersist: true, persistIntervalMs: 1000, ...(opts.config || {}) };
        this.entities = new Map(); // id → entity
        this.nameIndex = new Map(); // lower(name) → id
        this.relations = [];
        this.snapshotFile = path.join(this.dbPath, 'km-graph.json');
        this._dirty = false;
        this._timer = null;
    }

    async initialize() {
        fs.mkdirSync(this.dbPath, { recursive: true });
        if (fs.existsSync(this.snapshotFile)) {
            try {
                const raw = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
                for (const e of raw.entities || []) {
                    this.entities.set(e.id, e);
                    if (e.name) this.nameIndex.set(e.name.toLowerCase(), e.id);
                }
                this.relations = raw.relations || [];
            } catch (err) {
                console.warn('[GraphDB] snapshot unreadable, starting empty:', err.message);
            }
        }
        return this;
    }

    async close() {
        this.persist();
    }

    _touch() {
        this._dirty = true;
        if (!this.config.autoPersist) return;
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this.persist();
        }, Math.max(200, this.config.persistIntervalMs));
        if (typeof this._timer.unref === 'function') this._timer.unref();
    }

    persist() {
        if (!this._dirty) return;
        this._dirty = false;
        try {
            fs.writeFileSync(
                this.snapshotFile,
                JSON.stringify({ entities: [...this.entities.values()], relations: this.relations }),
            );
        } catch (err) {
            console.warn('[GraphDB] persist failed:', err.message);
        }
    }

    addEntity(entity) {
        const e = { ...entity };
        if (!e.id) e.id = mintId();
        if (!e.createdAt) e.createdAt = new Date().toISOString();
        if (!e.name && e.title) e.name = e.title;
        const oldId = e.name ? this.nameIndex.get(e.name.toLowerCase()) : null;
        if (oldId && oldId !== e.id) e.id = oldId; // upsert by name
        const prev = this.entities.get(e.id);
        this.entities.set(e.id, prev ? { ...prev, ...e } : e);
        if (e.name) this.nameIndex.set(e.name.toLowerCase(), e.id);
        this._touch();
        this.emit('change', { type: prev ? 'update' : 'add', entity: e });
        return e.id;
    }

    updateEntity(idOrName, patch) {
        const e = this.getEntity(idOrName);
        if (!e) return null;
        Object.assign(e, patch, { id: e.id });
        this.entities.set(e.id, e);
        this._touch();
        this.emit('change', { type: 'update', entity: e });
        return e;
    }

    getEntity(idOrName) {
        return (
            this.entities.get(idOrName) ||
            (idOrName ? this.entities.get(this.nameIndex.get(String(idOrName).toLowerCase())) : undefined)
        );
    }

    findByName(name) {
        const id = this.nameIndex.get(String(name).toLowerCase());
        return id ? this.entities.get(id) : undefined;
    }

    deleteEntity(idOrName) {
        const e = this.getEntity(idOrName);
        if (!e) return false;
        this.entities.delete(e.id);
        if (e.name) this.nameIndex.delete(e.name.toLowerCase());
        this.relations = this.relations.filter((r) => r.from !== e.id && r.to !== e.id);
        this._touch();
        this.emit('change', { type: 'delete', entity: e });
        return true;
    }

    /**
     * Query entities.
     * @param {{team?:string, ontologyClass?:string, entityType?:string,
     *          searchTerm?:string, limit?:number, offset?:number}} options
     */
    queryEntities(options = {}) {
        let list = [...this.entities.values()];
        if (options.team) list = list.filter((e) => !e.team || e.team === options.team || e.metadata?.team === options.team);
        const cls = options.ontologyClass || options.entityType;
        if (cls) list = list.filter((e) => e.ontologyClass === cls || e.entityType === cls);
        if (options.searchTerm) {
            const needle = options.searchTerm.toLowerCase();
            list = list.filter((e) =>
                (e.name || '').toLowerCase().includes(needle) ||
                (e.description || '').toLowerCase().includes(needle) ||
                (e.observations || []).some((o) => String(o).toLowerCase().includes(needle)));
        }
        const total = list.length;
        const off = Number(options.offset) || 0;
        const lim = Number(options.limit) || 200;
        return { entities: list.slice(off, off + lim), total };
    }

    addRelation(relation) {
        const rel = {
            id: relation.id || mintId(),
            from: relation.from,
            to: relation.to,
            type: relation.type || 'related_to',
            metadata: relation.metadata || {},
            createdAt: new Date().toISOString(),
        };
        this.relations.push(rel);
        this._touch();
        this.emit('change', { type: 'relation', relation: rel });
        return rel.id;
    }

    /** Relations matching {from?, to?, type?} (ids or names). */
    queryRelations(match = {}) {
        const resolve = (x) => this.getEntity(x)?.id ?? x;
        return this.relations.filter((r) => {
            if (match.from && r.from !== resolve(match.from)) return false;
            if (match.to && r.to !== resolve(match.to)) return false;
            if (match.type && r.type !== match.type) return false;
            return true;
        });
    }

    getStats() {
        const classes = {};
        for (const e of this.entities.values()) {
            const c = e.ontologyClass || e.entityType || 'unclassified';
            classes[c] = (classes[c] || 0) + 1;
        }
        return {
            entities: this.entities.size,
            relations: this.relations.length,
            classes,
        };
    }
}

export default GraphDatabaseService;
