/**
 * UKBDatabaseWriter — team-scoped write facade over the graph store.
 * Constructor signature mirrors the original consumer:
 *   new UKBDatabaseWriter(databaseManager, { team, debug })
 */

export class UKBDatabaseWriter {
    constructor(databaseManager, opts = {}) {
        this.databaseManager = databaseManager || null;
        this.team = opts.team || 'coding';
        this.debug = !!opts.debug;
        // Write through the graph attached to the manager when present.
        this.graphDB = databaseManager?.graphDB || null;
    }

    _stamp(entity) {
        return {
            ...entity,
            team: entity.team || this.team,
            metadata: { ...(entity.metadata || {}), team: entity.metadata?.team || this.team },
            updatedAt: new Date().toISOString(),
        };
    }

    storeEntity(entity) {
        const e = this._stamp(entity);
        if (this.graphDB) return this.graphDB.addEntity(e);
        // No graph backend: keep the write in-memory on the writer so callers
        // can still read back what they stored during this session.
        if (!this._local) this._local = new Map();
        const id = e.id || `${this.team}:${e.name}`;
        e.id = id;
        this._local.set(id, e);
        return id;
    }

    updateEntity(idOrName, patch) {
        const stamped = this._stamp(patch || {});
        if (this.graphDB) return this.graphDB.updateEntity(idOrName, stamped);
        return null;
    }

    deleteEntity(idOrName) {
        if (this.graphDB) return this.graphDB.deleteEntity(idOrName);
        return false;
    }
}

export default UKBDatabaseWriter;
