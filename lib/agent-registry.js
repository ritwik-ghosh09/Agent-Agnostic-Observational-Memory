const AgentDetector = require('./agent-detector');
const ClaudeMCPAdapter = require('./adapters/claude-mcp');
const CoPilotAdapter = require('./adapters/copilot');

class AgentRegistry {
  constructor() {
    this.adapters = new Map();
    this.detector = new AgentDetector();
  }

  /**
   * Register an adapter for an agent
   */
  register(agentName, adapterClass) {
    this.adapters.set(agentName, adapterClass);
  }

  /**
   * Get an adapter instance for a specific agent
   */
  async getAdapter(agentName, config = {}) {
    const AdapterClass = this.adapters.get(agentName);
    if (!AdapterClass) {
      throw new Error(`No adapter registered for agent: ${agentName}`);
    }

    const adapter = new AdapterClass(config);
    await adapter.initialize();
    return adapter;
  }

  /**
   * Get the best available adapter
   */
  async getBestAdapter(config = {}) {
    const bestAgent = await this.detector.getBest();
    if (!bestAgent) {
      throw new Error('No supported agents available');
    }

    return await this.getAdapter(bestAgent, config);
  }

  /**
   * List all registered adapters
   */
  listAdapters() {
    return Array.from(this.adapters.keys());
  }

  /**
   * Check if an adapter is registered
   */
  hasAdapter(agentName) {
    return this.adapters.has(agentName);
  }
}

// Create default registry instance
const registry = new AgentRegistry();

// Register built-in adapters
registry.register('claude', ClaudeMCPAdapter);
registry.register('copilot', CoPilotAdapter);

/**
 * Get an adapter for a specific agent
 */
async function getAdapter(agentName, config = {}) {
  return await registry.getAdapter(agentName, config);
}

/**
 * Get the best available adapter
 */
async function getBestAdapter(config = {}) {
  return await registry.getBestAdapter(config);
}

module.exports = {
  AgentRegistry,
  registry,
  getAdapter,
  getBestAdapter
};