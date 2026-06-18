#!/usr/bin/env node

/**
 * Shell-friendly wrapper for Process State Manager
 *
 * Usage:
 *   node psm-register.js <name> <pid> <type> <script> [projectPath] [sessionId]
 *   node psm-register.js --check <name> <type> [projectPath] [sessionId]
 */

import ProcessStateManager from './process-state-manager.js';

const manager = new ProcessStateManager();

const command = process.argv[2];

(async () => {
  try {
    if (command === '--check') {
      // Check if service is running
      const name = process.argv[3];
      const type = process.argv[4];
      const projectPath = process.argv[5];
      const sessionId = process.argv[6];

      const context = {};
      if (projectPath) context.projectPath = projectPath;
      if (sessionId) context.sessionId = sessionId;

      const isRunning = await manager.isServiceRunning(name, type, context);
      console.log(isRunning ? 'true' : 'false');
      process.exit(isRunning ? 0 : 1);
    } else {
      // Register service
      const name = command;
      const pid = parseInt(process.argv[3]);
      const type = process.argv[4];
      const script = process.argv[5];
      const projectPath = process.argv[6];
      const sessionId = process.argv[7];

      if (!name || isNaN(pid) || !type || !script) {
        console.error('Usage: psm-register.js <name> <pid> <type> <script> [projectPath] [sessionId]');
        console.error('   or: psm-register.js --check <name> <type> [projectPath] [sessionId]');
        process.exit(1);
      }

      const serviceInfo = {
        name,
        pid,
        type,
        script
      };

      if (projectPath) serviceInfo.projectPath = projectPath;
      if (sessionId) serviceInfo.sessionId = sessionId;

      await manager.registerService(serviceInfo);
      console.log(`✅ Registered ${name} (PID: ${pid}, type: ${type})`);
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
})();
