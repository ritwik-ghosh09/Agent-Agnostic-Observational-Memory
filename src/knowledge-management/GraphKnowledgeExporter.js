/**
 * GraphKnowledgeExporter — mirrors graph changes back to
 * .data/knowledge-export/<team>.json (debounced, pretty-printed).
 */

import fs from 'fs';
import path from 'path';

export class GraphKnowledgeExporter {
    constructor(graphDB, opts = {}) {
        this.graphDB = graphDB;
        this.opts = {
            autoExport: true,
            debounceMs: 5000,
            prettyFormat: true,
            exportDir: process.env.KNOWLEDGE_EXPORT_DIR ||
                path.join(process.cwd(), '.data', 'knowledge-export'),
            ...opts,
        };
        this._timer = null;
    }

    async initialize() {
        if (this.opts.autoExport && typeof this.graphDB.on === 'function') {
            this.graphDB.on('change', () => this.scheduleExport());
        }
        return this;
    }

    scheduleExport() {
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            try {
                this.exportAll();
            } catch (err) {
                console.warn('[GraphExporter] export failed:', err.message);
            }
        }, Math.max(500, this.opts.debounceMs));
        if (typeof this._timer.unref === 'function') this._timer.unref();
    }

    /** Group entities by team and write one JSON per team. */
    exportAll() {
        const byTeam = new Map();
        for (const e of this.graphDB.entities.values()) {
            const team = e.team || e.metadata?.team || 'coding';
            if (!byTeam.has(team)) byTeam.set(team, { entities: [], relations: [] });
            byTeam.get(team).entities.push(e);
        }
        for (const r of this.graphDB.relations) {
            const fromEntity = this.graphDB.entities.get(r.from);
            const team = fromEntity?.team || fromEntity?.metadata?.team || 'coding';
            if (!byTeam.has(team)) byTeam.set(team, { entities: [], relations: [] });
            byTeam.get(team).relations.push(r);
        }
        fs.mkdirSync(this.opts.exportDir, { recursive: true });
        const space = this.opts.prettyFormat ? 2 : 0;
        for (const [team, doc] of byTeam) {
            const file = path.join(this.opts.exportDir, `${team}.json`);
            fs.writeFileSync(file, JSON.stringify({
                metadata: { team, exportedAt: new Date().toISOString() },
                ...doc,
            }, null, space));
        }
        return [...byTeam.keys()];
    }
}

export default GraphKnowledgeExporter;
