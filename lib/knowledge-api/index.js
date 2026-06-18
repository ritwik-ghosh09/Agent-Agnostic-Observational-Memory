/**
 * Knowledge API - Agent-agnostic knowledge management system
 * 
 * Provides a clean, stable API for managing entities, relations, and insights
 * across different coding assistants and platforms.
 */

import { EntityManager } from './core/entities.js';
import { RelationManager } from './core/relations.js';
import { InsightProcessor } from './core/insights.js';
import { ValidationService } from './core/validation-simple.js';
import { FileStorageAdapter } from './adapters/file-storage.js';
import { MultiFileStorageAdapter } from './adapters/multi-file-storage.js';
import { ConfigManager } from './utils/config.js';
import { Logger } from './utils/logging.js';

export class KnowledgeAPI {
  constructor(options = {}) {
    this.config = new ConfigManager(options);
    this.logger = new Logger(this.config.get('logging'));
    
    // Initialize storage adapter
    const storageConfig = this.config.get('storage');
    
    // Use multi-file adapter if team is specified
    if (storageConfig.team && storageConfig.team !== 'default') {
      this.storage = new MultiFileStorageAdapter(storageConfig, this.logger);
    } else {
      // Use standard adapter for backward compatibility
      this.storage = new FileStorageAdapter(storageConfig, this.logger);
    }
    
    // Initialize core services
    this.validation = new ValidationService();
    this.entities = new EntityManager(this.storage, this.validation, this.logger);
    this.relations = new RelationManager(this.storage, this.validation, this.logger);
    this.insights = new InsightProcessor(this.entities, this.relations, this.logger);
  }

  /**
   * Initialize the knowledge base
   */
  async initialize() {
    await this.storage.initialize();
    this.logger.info('Knowledge API initialized');
  }

  /**
   * Create a new knowledge base file (only for ukb command)
   */
  async createNew() {
    if (this.storage.createNewFile) {
      await this.storage.createNewFile();
    } else {
      throw new Error('Storage adapter does not support file creation');
    }
  }

  /**
   * Get API status and statistics
   */
  async getStatus() {
    const entityCount = await this.entities.count();
    const relationCount = await this.relations.count();
    
    return {
      status: 'ready',
      version: '1.0.0',
      storage: this.storage.getInfo(),
      stats: {
        entities: entityCount,
        relations: relationCount
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Close the API and cleanup resources
   */
  async close() {
    await this.storage.close();
    this.logger.info('Knowledge API closed');
  }
}

// Export individual managers for direct use
export {
  EntityManager,
  RelationManager,
  InsightProcessor,
  ValidationService,
  FileStorageAdapter,
  ConfigManager,
  Logger
};

// Default export
export default KnowledgeAPI;