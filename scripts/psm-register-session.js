#!/usr/bin/env node

/**
 * Register a session with Process State Manager
 *
 * Usage: psm-register-session.js <sessionId> <pid> <projectDir>
 */

import ProcessStateManager from './process-state-manager.js';

const manager = new ProcessStateManager();

const sessionId = process.argv[2];
const pid = parseInt(process.argv[3]);
const projectDir = process.argv[4];

if (!sessionId || isNaN(pid) || !projectDir) {
  console.error('Usage: psm-register-session.js <sessionId> <pid> <projectDir>');
  process.exit(1);
}

(async () => {
  try {
    const metadata = {
      pid,
      startTime: Date.now(),
      projectDir
    };

    await manager.registerSession(sessionId, metadata);
    console.log(`✅ Session registered: ${sessionId}`);
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
})();
