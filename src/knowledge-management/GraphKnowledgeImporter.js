/**
 * GraphKnowledgeImporter — seeds the graph from .data/knowledge-export/*.json.
 * Conflict resolution: 'newest-wins' (default) compares updatedAt/createdAt.
 */

import fs from 'fs';
import path from 'path';

export class GraphKnowledgeImporter {
    constructor(graphDB, opts = {}) {
        this.graphDB = graphDB;
        this.opts = {
            autoImportOnStartup: true,
            conflictResolution: 'newest-wins',
            exportDir: process.env.KNOWLEDGE_EXPORT_DIR ||
                path.join(process.cwd(), '.data', 'knowledge-export'),
            ...opts,
        };
    }

    async initialize() {
        if (!this.opts.autoImportOnStartup) return { imported: 0 };
        return this.importAll();
    }

    importAll() {
        let imported = 0;
        const dir = this.opts.exportDir;
        if (!fs.existsSync(dir)) return { imported };
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.json')) continue;
            try {
                const team = file.replace(/\.json$/, '');
                const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
                imported += this.importDocument(doc, team);
            } catch (err) {
                console.warn(`[GraphImporter] skipped ${file}: ${err.message}`);
            }
        }
        return { imported };
    }

    importDocument(doc, team = 'coding') {
        let count = 0;
        const entities = Array.isArray(doc)
            ? doc
            : doc.entities
                ? (Array.isArray(doc.entities) ? doc.entities : Object.entries(doc.entities).map(([name, v]) => ({ name, ...v })))
                : [];
        for (const e of entities) {
            if (!e?.name) continue;
            const existing = this.graphDB.findByName(e.name);
            const candidate = { ...e, team: e.team || team };
            if (existing && this.opts.conflictResolution === 'newest-wins') {
                const candT = Date.parse(candidate.updatedAt || candidate.createdAt || '') || 0;
                const exT = Date.parse(existing.updatedAt || existing.createdAt || '') || 0;
                if (candT < exT) continue;
            }
            this.graphDB.addEntity(candidate);
            count += 1;
        }
        const relations = doc?.relations;
        if (Array.isArray(relations)) {
            for (const r of relations) {
                if (r?.from && r?.to) this.graphDB.addRelation(r);
            }
        }
        return count;
    }
}

export default GraphKnowledgeImporter;
