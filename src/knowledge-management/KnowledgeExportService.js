/**
 * KnowledgeExportService — online knowledge export orchestration.
 * Backed by DatabaseManager (vectors/analytics) + GraphDatabaseService.
 */

export class KnowledgeExportService {
    constructor(opts = {}) {
        this.databaseManager = opts.databaseManager || null;
        this.embeddingGenerator = opts.embeddingGenerator || null;
        this.debug = !!opts.debug;
    }

    /**
     * Export entities (optionally generating embeddings) into the vector
     * store. Graceful no-op when no database backend is available.
     */
    async exportEntities(entities = [], { collection = 'knowledge_patterns' } = {}) {
        if (!this.databaseManager) return { exported: 0, reason: 'no database backend' };
        let exported = 0;
        for (const e of entities) {
            try {
                const text = [
                    e.name,
                    e.description || '',
                    ...(e.observations || []),
                ].filter(Boolean).join('\n');
                let embedding = null;
                if (this.embeddingGenerator?.generateEmbedding) {
                    embedding = await this.embeddingGenerator.generateEmbedding(text);
                }
                if (embedding && this.databaseManager.storeVector) {
                    await this.databaseManager.storeVector(collection, e.id || e.name, embedding, {
                        name: e.name,
                        team: e.team,
                        ontologyClass: e.ontologyClass || e.entityType,
                    });
                    exported += 1;
                }
            } catch (err) {
                if (this.debug) console.warn('[KnowledgeExport] entity failed:', err.message);
            }
        }
        return { exported };
    }

    async exportAll(entities) {
        return this.exportEntities(entities);
    }
}

export default KnowledgeExportService;
