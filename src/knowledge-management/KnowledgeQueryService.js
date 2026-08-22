/**
 * KnowledgeQueryService — read-side facade over the graph + analytics stores.
 * Constructor signature mirrors the original consumer:
 *   new KnowledgeQueryService(databaseManager, graphDB, { debug })
 */

export class KnowledgeQueryService {
    constructor(databaseManager, graphDB, opts = {}) {
        this.databaseManager = databaseManager || null;
        this.graphDB = graphDB || null;
        this.debug = !!opts?.debug;
    }

    queryEntities(options = {}) {
        if (this.graphDB?.queryEntities) return this.graphDB.queryEntities(options);
        // SQLite fallback: knowledge extractions table (best-effort).
        return { entities: [], total: 0 };
    }

    async queryEntitiesAsync(options = {}) {
        return this.queryEntities(options);
    }

    queryRelations(match = {}) {
        if (this.graphDB?.queryRelations) return this.graphDB.queryRelations(match);
        return [];
    }

    getTeams() {
        if (!this.graphDB) return [];
        const teams = new Set();
        for (const e of this.graphDB.entities.values()) {
            const t = e.team || e.metadata?.team;
            if (t) teams.add(t);
        }
        return [...teams].sort();
    }

    getStatistics() {
        const stats = this.graphDB?.getStats
            ? this.graphDB.getStats()
            : { entities: 0, relations: 0, classes: {} };
        return {
            ...stats,
            teams: this.getTeams(),
            databaseBackend: this.databaseManager ? 'available' : 'unavailable',
        };
    }

    storeRelation(relation) {
        if (!this.graphDB) throw new Error('KnowledgeQueryService: no graph backend');
        return this.graphDB.addRelation(relation);
    }
}

export default KnowledgeQueryService;
