#!/usr/bin/env node

/**
 * Health Remediation Actions - Auto-Healing Library
 *
 * Provides automated remediation for detected health issues.
 * Implements retry logic, backoff strategies, and safety checks.
 *
 * Safety Features:
 * - Maximum retry attempts with exponential backoff
 * - Cooldown periods to prevent restart loops
 * - Verification after remediation
 * - Escalation when auto-healing fails
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, openSync, closeSync, mkdirSync } from 'fs';
import ProcessStateManager from './process-state-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptRoot = join(__dirname, '..');

const execAsync = promisify(exec);

/**
 * Map of remediation actions to supervisord group:program names
 */
const DOCKER_SERVICE_MAP = {
  restart_vkb_server: 'web-services:vkb-server',
  restart_constraint_monitor: 'mcp-servers:constraint-monitor',
  restart_dashboard_server: 'web-services:health-dashboard-frontend',
  restart_health_api: 'web-services:health-dashboard',
  restart_health_frontend: 'web-services:health-dashboard-frontend',
};

export class HealthRemediationActions {
  constructor(options = {}) {
    this.codingRoot = options.codingRoot || process.env.CODING_REPO || scriptRoot;
    this.psm = new ProcessStateManager({ codingRoot: this.codingRoot });
    this.debug = options.debug || false;

    this.log('Using supervisorctl for service restarts');

    // Track healing attempts for cooldown enforcement
    this.healingAttempts = new Map(); // action -> { count, lastAttempt, cooldownUntil }
    this.maxAttemptsPerHour = options.maxAttemptsPerHour || 10;
    this.cooldownSeconds = options.cooldownSeconds || 300; // 5 minutes
  }

  /**
   * Log message
   */
  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] [Remediation] ${message}`;

    if (this.debug || level === 'ERROR') {
      console.log(logEntry);
    }
  }

  /**
   * Check if action is in cooldown
   */
  isInCooldown(actionName) {
    const attempt = this.healingAttempts.get(actionName);
    if (!attempt) return false;

    const now = Date.now();
    if (attempt.cooldownUntil && now < attempt.cooldownUntil) {
      return true;
    }

    // Check hourly rate limit
    const oneHourAgo = now - (60 * 60 * 1000);
    if (attempt.lastAttempt > oneHourAgo && attempt.count >= this.maxAttemptsPerHour) {
      return true;
    }

    return false;
  }

  /**
   * Record healing attempt
   */
  recordAttempt(actionName, success) {
    const now = Date.now();
    const attempt = this.healingAttempts.get(actionName) || { count: 0, lastAttempt: 0 };

    // Reset counter if more than 1 hour passed
    const oneHourAgo = now - (60 * 60 * 1000);
    if (attempt.lastAttempt < oneHourAgo) {
      attempt.count = 0;
    }

    attempt.count++;
    attempt.lastAttempt = now;

    // Set cooldown if failed
    if (!success) {
      attempt.cooldownUntil = now + (this.cooldownSeconds * 1000);
    }

    this.healingAttempts.set(actionName, attempt);
  }

  /**
   * Execute remediation action
   */
  async executeAction(actionName, issueDetails = {}) {
    this.log(`Executing remediation: ${actionName}`);

    // Check cooldown
    if (this.isInCooldown(actionName)) {
      this.log(`Action ${actionName} is in cooldown period`, 'WARN');
      return {
        success: false,
        action: actionName,
        reason: 'cooldown',
        message: 'Action is in cooldown period'
      };
    }

    try {
      // Route to specific action handler
      let result;
      switch (actionName) {
        case 'kill_lock_holder':
          result = await this.killLockHolder(issueDetails);
          break;
        case 'cleanup_dead_processes':
          result = await this.cleanupDeadProcesses(issueDetails);
          break;
        case 'restart_vkb_server':
          result = await this.restartVKBServer(issueDetails);
          break;
        case 'restart_constraint_monitor':
          result = await this.restartConstraintMonitor(issueDetails);
          break;
        case 'restart_dashboard_server':
          result = await this.restartDashboardServer(issueDetails);
          break;
        case 'restart_health_api':
          result = await this.restartHealthAPI(issueDetails);
          break;
        case 'restart_health_frontend':
          result = await this.restartHealthFrontend(issueDetails);
          break;
        case 'start_qdrant':
          result = await this.startQdrant(issueDetails);
          break;
        case 'restart_graph_database':
          result = await this.restartGraphDatabase(issueDetails);
          break;
        case 'cleanup_zombies':
          result = await this.cleanupZombies(issueDetails);
          break;
        case 'restart_transcript_monitor':
          result = await this.restartTranscriptMonitor(issueDetails);
          break;
        case 'regenerate_services_file':
          result = await this.regenerateServicesFile(issueDetails);
          break;
        case 'restart_llm_cli_proxy':
          result = await this.restartLLMCLIProxy(issueDetails);
          break;
        case 'restart_obs_api':
          result = await this.restartObsApi(issueDetails);
          break;
        case 'check_llm_cli_proxy':
          result = await this.checkLLMCLIProxy(issueDetails);
          break;
        case 'check_mastra_agent':
          result = await this.checkMastraAgent(issueDetails);
          break;
        default:
          this.log(`Unknown action: ${actionName}`, 'ERROR');
          return {
            success: false,
            action: actionName,
            reason: 'unknown_action',
            message: `No handler for action: ${actionName}`
          };
      }

      // Record attempt
      this.recordAttempt(actionName, result.success);

      if (result.success) {
        this.log(`Remediation successful: ${actionName}`);
      } else {
        this.log(`Remediation failed: ${actionName} - ${result.message}`, 'ERROR');
      }

      return result;

    } catch (error) {
      this.log(`Remediation error: ${actionName} - ${error.message}`, 'ERROR');
      this.recordAttempt(actionName, false);

      return {
        success: false,
        action: actionName,
        reason: 'exception',
        message: error.message
      };
    }
  }

  /**
   * Kill process holding database lock
   * VKB server legitimately holds the lock in Docker — skip killing.
   */
  async killLockHolder(details) {
    this.log('VKB server owns LevelDB lock legitimately - skipping kill');
    return { success: true, message: 'Lock holder is VKB server (expected)' };
  }

  /**
   * Clean up dead processes from registry
   */
  async cleanupDeadProcesses(details) {
    try {
      const cleaned = await this.psm.cleanupDeadProcesses();
      return {
        success: true,
        message: `Cleaned ${cleaned} dead process(es) from registry`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Restart VKB server
   */
  async restartVKBServer(details) {
    try {
      this.log('Restarting VKB server...');
      return await this.supervisorctlRestart('restart_vkb_server', 'http://localhost:8080/health');
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Restart constraint monitor
   */
  async restartConstraintMonitor(details) {
    try {
      this.log('Restarting constraint monitor...');
      const port = process.env.CONSTRAINT_MONITOR_PORT || '3849';
      return await this.supervisorctlRestart('restart_constraint_monitor', `http://localhost:${port}/health`);
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Restart dashboard server
   */
  async restartDashboardServer(details) {
    try {
      this.log('Restarting dashboard server...');
      const port = process.env.HEALTH_DASHBOARD_PORT || '3032';
      return await this.supervisorctlRestart('restart_dashboard_server', `http://localhost:${port}`);
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  async restartHealthAPI(details) {
    try {
      this.log('Restarting System Health API server...');
      return await this.supervisorctlRestart('restart_health_api', 'http://localhost:3033/api/health');
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Restart System Health Dashboard Frontend (Vite dev server)
   */
  async restartHealthFrontend(details) {
    try {
      this.log('Restarting System Health Dashboard frontend...');
      const port = process.env.HEALTH_DASHBOARD_PORT || '3032';
      return await this.supervisorctlRestart('restart_health_frontend', `http://localhost:${port}`);
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Start Qdrant vector database
   */
  async startQdrant(details) {
    this.log('Qdrant runs as a separate container managed by docker-compose externally');
    return { success: false, message: 'Qdrant is managed by docker-compose externally' };
  }

  /**
   * Restart graph database service
   */
  async restartGraphDatabase(details) {
    try {
      this.log('Restarting graph database...');

      // The graph database is typically embedded, so restart means
      // restarting the service that uses it (like VKB or UKB)

      // For now, just clean up any locks
      const lockPath = `${this.codingRoot}/.data/knowledge-graph/LOCK`;

      try {
        const { stdout } = await execAsync(`lsof ${lockPath}`);
        const lines = stdout.split('\n').filter(l => l.trim());

        if (lines.length > 1) {
          const match = lines[1].match(/\s+(\d+)\s+/);
          if (match) {
            const pid = parseInt(match[1]);
            this.log(`Killing process holding graph DB lock: ${pid}`);
            process.kill(pid, 'SIGTERM');
            await this.sleep(1000);
          }
        }
      } catch (error) {
        // No lock file or lsof failed - that's okay
      }

      return { success: true, message: 'Graph database lock cleared' };

    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Clean up zombie processes
   */
  async cleanupZombies(details) {
    try {
      this.log('Cleaning up zombie processes...');

      // Find zombie processes
      const { stdout } = await execAsync('ps aux | grep defunct | grep -v grep');

      if (!stdout.trim()) {
        return { success: true, message: 'No zombie processes found' };
      }

      const zombies = stdout.trim().split('\n');
      let cleaned = 0;

      for (const zombie of zombies) {
        const parts = zombie.trim().split(/\s+/);
        const pid = parseInt(parts[1]);

        if (pid) {
          try {
            // Kill parent process to reap zombies
            const { stdout: parentInfo } = await execAsync(`ps -o ppid= -p ${pid}`);
            const ppid = parseInt(parentInfo.trim());

            if (ppid && ppid > 1) {
              process.kill(ppid, 'SIGCHLD');
              cleaned++;
            }
          } catch (error) {
            // Ignore errors for individual zombies
          }
        }
      }

      return {
        success: true,
        message: `Sent SIGCHLD to ${cleaned} parent process(es)`
      };

    } catch (error) {
      // No zombies found or ps command failed
      return { success: true, message: 'No zombie processes found' };
    }
  }

  /**
   * Restart enhanced transcript monitor (LSL system)
   */
  async restartTranscriptMonitor(details) {
    try {
      this.log('Restarting enhanced transcript monitor...');

      const projectPath = details.project_path || this.codingRoot;
      const projectName = projectPath.split('/').pop();

      // Check if project was intentionally stopped (prevents restart loops)
      try {
        if (await this.psm.isProjectStopped(projectPath)) {
          return {
            success: false,
            message: `Project ${projectName} is intentionally stopped. Use 'node scripts/process-state-manager.js unstop ${projectPath}' to resume.`
          };
        }
      } catch {
        // Fail-open: if check fails, continue with restart
      }

      // Kill existing monitor if registered in PSM
      try {
        const service = await this.psm.getService('enhanced-transcript-monitor', 'per-project', projectPath);
        if (service && service.pid) {
          this.log(`Killing existing transcript monitor (PID: ${service.pid})`);
          try {
            process.kill(service.pid, 'SIGTERM');
            await this.sleep(2000);
          } catch (killError) {
            // Process might already be dead
          }
          // Unregister from PSM
          await this.psm.unregisterService('enhanced-transcript-monitor', 'per-project', projectPath);
        }
      } catch (error) {
        // No existing service found
      }

      // Also kill any orphan monitors for this project
      try {
        const { stdout } = await execAsync(`pgrep -f "enhanced-transcript-monitor.js.*${projectName}"`);
        const pids = stdout.trim().split('\n').filter(p => p);
        for (const pidStr of pids) {
          const pid = parseInt(pidStr);
          if (pid) {
            this.log(`Killing orphan transcript monitor (PID: ${pid})`);
            try {
              process.kill(pid, 'SIGTERM');
            } catch (e) {
              // Ignore
            }
          }
        }
        await this.sleep(1000);
      } catch (error) {
        // pgrep found nothing, that's fine
      }

      // Start new transcript monitor
      const monitorScript = `${this.codingRoot}/scripts/enhanced-transcript-monitor.js`;
      const cmd = `node ${monitorScript} ${projectPath} > /dev/null 2>&1 &`;

      await execAsync(cmd, {
        shell: '/bin/bash',
        timeout: 5000,
        cwd: this.codingRoot
      });

      await this.sleep(3000);

      // Verify it's running via PSM
      try {
        const service = await this.psm.getService('enhanced-transcript-monitor', 'per-project', projectPath);
        if (service && service.status === 'healthy') {
          return {
            success: true,
            message: `Transcript monitor restarted successfully (PID: ${service.pid})`
          };
        }
      } catch (error) {
        // Check failed
      }

      // Fallback: check if process is running
      try {
        const { stdout } = await execAsync(`pgrep -f "enhanced-transcript-monitor.js.*${projectName}"`);
        if (stdout.trim()) {
          return {
            success: true,
            message: `Transcript monitor started (PIDs: ${stdout.trim().replace(/\n/g, ', ')})`
          };
        }
      } catch (error) {
        // pgrep found nothing
      }

      return { success: false, message: 'Failed to start transcript monitor' };

    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Regenerate .services-running.json from health checks
   * This file is critical for the status line API indicator
   */
  async regenerateServicesFile(details) {
    try {
      this.log('Regenerating .services-running.json from health checks...');

      const statusFile = `${this.codingRoot}/.services-running.json`;

      const constraintPort = process.env.CONSTRAINT_MONITOR_PORT || '3849';
      const dashboardPort = process.env.HEALTH_DASHBOARD_PORT || '3032';

      // Gather health status from HTTP checks
      const vkbHealthy = await this.checkHttpHealth('http://localhost:8080/health', 2000);
      const constraintHealthy = await this.checkHttpHealth(`http://localhost:${constraintPort}/health`, 2000);
      const healthApiHealthy = await this.checkHttpHealth('http://localhost:3033/api/health', 2000);
      const dashboardHealthy = await this.checkPortListening(parseInt(dashboardPort));

      // Get PSM data for running services
      const psmHealth = await this.psm.getHealthStatus();
      const servicesRunning = [];

      // Check which services are running
      if (vkbHealthy) servicesRunning.push('vkb-server');
      if (constraintHealthy) servicesRunning.push('constraint-monitor');
      if (healthApiHealthy) servicesRunning.push('health-verifier');
      if (dashboardHealthy) servicesRunning.push('system-health-dashboard');

      const status = {
        timestamp: new Date().toISOString(),
        services: servicesRunning,
        services_running: servicesRunning.length,
        constraint_monitor: {
          status: constraintHealthy ? '✅ FULLY OPERATIONAL' : '⚠️ DEGRADED MODE',
          dashboard_port: parseInt(dashboardPort),
          api_port: parseInt(constraintPort),
          health: constraintHealthy ? 'healthy' : 'degraded',
          last_check: new Date().toISOString()
        },
        semantic_analysis: {
          status: '✅ OPERATIONAL',
          health: 'healthy'
        },
        vkb_server: {
          status: vkbHealthy ? '✅ OPERATIONAL' : '⚠️ DEGRADED',
          port: 8080,
          health: vkbHealthy ? 'healthy' : 'degraded',
          last_check: new Date().toISOString()
        },
        system_health_dashboard: {
          status: healthApiHealthy ? '✅ OPERATIONAL' : '⚠️ DEGRADED',
          dashboard_port: 3032,
          api_port: 3033,
          health: healthApiHealthy ? 'healthy' : 'degraded',
          last_check: new Date().toISOString()
        }
      };

      writeFileSync(statusFile, JSON.stringify(status, null, 2));
      this.log(`Regenerated ${statusFile}`);

      return {
        success: true,
        message: `Services status file regenerated with ${servicesRunning.length} active services`
      };

    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Restart the LLM CLI Proxy (port 12435).
   *
   * Single path used by the dashboard "Restart" button (Phase 33 33-15), the
   * 60s semantic auto-heal FSM (Plan 34-03) AND the 3s liveness watchdog
   * (Plan 34-xx). Cross-platform by design:
   *   - macOS (darwin): `launchctl kickstart -k` re-runs start-llm-proxy.sh via
   *     the launchd plist (com.coding.llm-cli-proxy), re-fetching the PAC so
   *     R3 (VPN/CN flap re-detection) keeps working.
   *   - Linux / Windows: there is no launchd, so kill whatever holds port 12435
   *     and respawn the canonical wrapper `src/llm-proxy/llm-proxy.mjs` detached
   *     (mirrors SERVICE_CONFIGS.llmCliProxy.startFn in start-services-robust.js).
   *
   * Previously this was macOS-only (`launchctl kickstart`), so on Linux the
   * auto-heal silently failed and a dead proxy stayed dead — the recurring
   * "LLM-proxy health" issue. Result shape preserved for the dashboard consumer.
   */
  async restartLLMCLIProxy(details) {
    const reason = details?.reason ?? 'unspecified';
    if (process.platform === 'darwin') {
      return this._restartLLMCLIProxyLaunchd(reason);
    }
    return this._restartLLMCLIProxyHostProcess(reason);
  }

  /** macOS path: launchctl kickstart -k gui/$UID/com.coding.llm-cli-proxy. */
  async _restartLLMCLIProxyLaunchd(reason) {
    try {
      const { execFile } = await import('node:child_process');
      const uid = process.getuid();
      this.log(`[HealthRemediationActions] Restarting LLM CLI Proxy via launchctl kickstart -k (reason: ${reason})...`);
      return await new Promise((resolve) => {
        execFile('launchctl',
          ['kickstart', '-k', `gui/${uid}/com.coding.llm-cli-proxy`],
          { timeout: 10_000 },
          (err, stdout, stderr) => {
            if (err) {
              this.log(`[HealthRemediationActions] launchctl kickstart failed: ${err.message} (stderr: ${stderr || 'empty'})`, 'ERROR');
              resolve({ success: false, message: `kickstart failed: ${err.message}`, stderr: stderr || '', reason });
              return;
            }
            this.log(`[HealthRemediationActions] launchctl kickstart -k dispatched (reason: ${reason})`);
            resolve({ success: true, message: `launchctl kickstart -k gui/${uid}/com.coding.llm-cli-proxy dispatched`, stdout: stdout || '', reason });
          }
        );
      });
    } catch (error) {
      this.log(`[HealthRemediationActions] restartLLMCLIProxy (launchd) threw: ${error.message}`, 'ERROR');
      return { success: false, message: error.message };
    }
  }

  /**
   * Linux / Windows path: free port 12435 then respawn the wrapper detached.
   * @param {string} reason
   */
  async _restartLLMCLIProxyHostProcess(reason) {
    // Serialize restarts. The 3s liveness watchdog AND the 60s semantic FSM can
    // both dispatch a restart; two concurrent respawns race to bind port 12435
    // and the loser crashes with EADDRINUSE (the proxy's listen 'error' is
    // unhandled → process exits), which the watchdog then "heals" again — a
    // self-inflicted restart loop. One restart at a time eliminates the race.
    if (this._proxyRestartLock) {
      this.log('[HealthRemediationActions] proxy restart already in progress — skipping concurrent request', 'INFO');
      return { success: true, message: 'restart already in progress', reason, skipped: true };
    }
    this._proxyRestartLock = true;
    try {
      const port = parseInt(process.env.LLM_CLI_PROXY_PORT || process.env.LLM_PROXY_PORT || '12435', 10);
      const wrapperEntry = join(this.codingRoot, 'src/llm-proxy/llm-proxy.mjs');

      if (!existsSync(wrapperEntry)) {
        return { success: false, message: `wrapper not found: ${wrapperEntry}`, reason };
      }

      this.log(`[HealthRemediationActions] Restarting LLM CLI Proxy (host process, port ${port}, reason: ${reason})...`);

      // 1. Kill whatever currently holds the port (graceful, then forced).
      await this._killProcessOnPort(port);

      // 2. Wait until the port is ACTUALLY free before respawning. Without this
      //    the new front server hits EADDRINUSE because the old socket lingers,
      //    crashes, and triggers another heal cycle.
      const freed = await this._waitForPortFree(port, 5000);
      if (!freed) {
        // Last resort: force-kill again and proceed; better to try than to bail.
        await this._killProcessOnPort(port);
        await this._waitForPortFree(port, 2000);
      }

      // 3. Respawn the canonical wrapper detached so it outlives the coordinator.
      const dataDir = join(this.codingRoot, '.data');
      try { mkdirSync(dataDir, { recursive: true }); } catch { /* exists */ }
      const logFile = join(dataDir, 'llm-cli-proxy.log');
      const logFd = openSync(logFile, 'a');
      const child = spawn('node', [wrapperEntry], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        cwd: this.codingRoot,
        env: { ...process.env, LLM_PROXY_PORT: String(port) }
      });
      closeSync(logFd);
      child.unref();

      // 4. Confirm it binds and is fully ready (poll /health for 200 up to ~15s,
      //    covering the in-process upstream's slow provider init).
      const ok = await this._waitForProxyHealth(port, 15000);
      if (ok) {
        this.log(`[HealthRemediationActions] LLM CLI Proxy healthy after respawn (pid ${child.pid})`);
        return { success: true, message: `llm-cli-proxy respawned on port ${port} (pid ${child.pid})`, pid: child.pid, reason };
      }
      // Process is up but not yet answering — still report success on spawn so
      // the watchdog's settle window applies; the next probe will re-evaluate.
      this.log(`[HealthRemediationActions] LLM CLI Proxy respawned (pid ${child.pid}) but /health not green within 8s`, 'WARN');
      return { success: true, message: `llm-cli-proxy respawned on port ${port} (pid ${child.pid}); health pending`, pid: child.pid, reason };
    } catch (error) {
      this.log(`[HealthRemediationActions] restartLLMCLIProxy (host) threw: ${error.message}`, 'ERROR');
      return { success: false, message: error.message, reason };
    } finally {
      this._proxyRestartLock = false;
    }
  }

  /**
   * Poll until no process LISTENS on <port> (cross-platform), or timeout.
   * @param {number} port
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true once the port is free
   */
  async _waitForPortFree(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let inUse = false;
      try {
        if (process.platform === 'win32') {
          const { stdout } = await execAsync(`netstat -ano | findstr :${port}`, { timeout: 3000 });
          inUse = /LISTENING/i.test(stdout);
        } else {
          const { stdout } = await execAsync(`lsof -ti:${port} -sTCP:LISTEN 2>/dev/null || true`, { timeout: 3000 });
          inUse = stdout.trim().length > 0;
        }
      } catch { inUse = false; }
      if (!inUse) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  /**
   * Cross-platform "kill whatever LISTENS on <port>".
   *
   * CRITICAL: match the LISTENING socket only. `lsof -i:PORT` (and
   * `netstat | findstr :PORT`) also match CLIENT connections whose *remote*
   * port is PORT — e.g. the health-coordinator's own /health probes to the
   * proxy. Killing those PIDs would terminate the coordinator itself. Restrict
   * to listeners (`-sTCP:LISTEN` / "LISTENING") and never kill our own PID.
   * @param {number} port
   */
  async _killProcessOnPort(port) {
    const selfPid = process.pid;
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync(`netstat -ano | findstr :${port}`, { timeout: 4000 });
        const pids = [...new Set(
          stdout.split('\n')
            .filter(l => /LISTENING/i.test(l))
            .map(l => l.trim().split(/\s+/).pop())
            .filter(p => /^\d+$/.test(p) && parseInt(p, 10) !== selfPid)
        )];
        for (const pid of pids) {
          try { await execAsync(`taskkill /F /PID ${pid}`, { timeout: 4000 }); } catch { /* gone */ }
        }
      } catch { /* nothing listening */ }
      return;
    }

    // Unix (Linux/macOS) — listeners only.
    const listeners = async () => {
      try {
        const { stdout } = await execAsync(`lsof -ti:${port} -sTCP:LISTEN 2>/dev/null || true`, { timeout: 4000 });
        return stdout.trim().split('\n')
          .filter(Boolean)
          .map(p => parseInt(p, 10))
          .filter(p => Number.isInteger(p) && p !== selfPid);
      } catch { return []; }
    };

    const pids = await listeners();
    if (pids.length === 0) return;

    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    // Give graceful shutdown a moment, then force-kill anything still bound.
    await new Promise(r => setTimeout(r, 800));
    for (const pid of await listeners()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }

  /**
   * Poll http://localhost:<port>/health until it returns HTTP 200 or timeout.
   * Confirms the freshly-spawned proxy is fully ready (front + in-process
   * upstream both up), not merely that the front socket is accepting.
   * @param {number} port
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async _waitForProxyHealth(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const url = `http://localhost:${port}/health`;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return true;
      } catch { /* not up yet */ }
      await new Promise(res => setTimeout(res, 400));
    }
    return false;
  }

  /**
   * Restart the observations API server via the dedicated restart script.
   * The obs_api runs on the host (not Docker) and is supervised by PSM.
   * Uses scripts/restart-obs-api.mjs which handles graceful shutdown of any
   * existing instance, spawns a new one, and re-registers with PSM.
   */
  async restartObsApi(details) {
    try {
      const reason = details?.reason ?? 'unspecified';
      this.log(`[HealthRemediationActions] Restarting obs_api (reason: ${reason})...`);

      const { execFile } = await import('node:child_process');
      const scriptPath = `${this.codingRoot}/scripts/restart-obs-api.mjs`;

      return await new Promise((resolve) => {
        execFile('node', [scriptPath], {
          cwd: this.codingRoot,
          timeout: 30000,
          env: { ...process.env, HOME: process.env.HOME || '/root' }
        }, (error, stdout, stderr) => {
          if (error) {
            this.log(`[HealthRemediationActions] restartObsApi failed: ${error.message}`, 'ERROR');
            resolve({ success: false, message: `obs_api restart failed: ${error.message}`, stdout, stderr });
          } else {
            this.log(`[HealthRemediationActions] obs_api restarted successfully`);
            resolve({ success: true, message: 'obs_api restarted via restart-obs-api.mjs', stdout });
          }
        });
      });
    } catch (error) {
      this.log(`[HealthRemediationActions] restartObsApi threw: ${error.message}`, 'ERROR');
      return { success: false, message: error.message };
    }
  }

  /**
   * Check LLM CLI Proxy status (informational only - host service, no auto-heal)
   * The proxy runs on the host at port 12435 and bridges CLI tools for Docker.
   */
  async checkLLMCLIProxy(details) {
    try {
      this.log('Checking LLM CLI Proxy status...');

      const proxyHost = 'host.docker.internal';
      const proxyPort = process.env.LLM_CLI_PROXY_PORT || '12435';
      const proxyUrl = `http://${proxyHost}:${proxyPort}/health`;

      const isHealthy = await this.checkHttpHealth(proxyUrl, 3000);

      if (isHealthy) {
        return {
          success: true,
          message: `LLM CLI Proxy is running on port ${proxyPort}`
        };
      }

      // Proxy not running - provide guidance (cannot auto-heal host services from Docker)
      return {
        success: false,
        message: `LLM CLI Proxy not responding on port ${proxyPort}. ` +
          'Start on host: cd integrations/llm-cli-proxy && npm start'
      };

    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Check mastra agent health and attempt recovery
   * Detects mastra process via tmux session (coding-mastra-*) or ps.
   * Per D-15: LLM proxy unreachable at startup warns but does NOT block —
   * mastra agent is NOT marked unhealthy just because proxy is down.
   */
  async checkMastraAgent(details) {
    try {
      this.log('Checking mastra agent health...');

      // Check if mastra process is running via tmux sessions
      let mastraSessions = '';
      try {
        const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^coding-mastra-"', { timeout: 5000 });
        mastraSessions = stdout.trim();
      } catch (e) {
        // No mastra tmux sessions — normal if not running
      }

      // Also check via ps for mastra/mastracode processes
      let mastraProcesses = '';
      try {
        const { stdout } = await execAsync('ps -eo pid,comm | awk \'$2 == "mastra" || $2 == "mastracode" {print $1}\'', { timeout: 5000 });
        mastraProcesses = stdout.trim();
      } catch (e) {
        // No mastra processes — normal if not running
      }

      const isRunning = !!(mastraSessions || mastraProcesses);

      if (!isRunning) {
        return {
          success: true,
          message: 'Mastra agent is not running (no active sessions or processes)'
        };
      }

      // Mastra is running — check LLM proxy connectivity (non-blocking per D-15)
      const proxyPort = process.env.LLM_CLI_PROXY_PORT || '12435';
      const proxyHost = 'host.docker.internal';
      const proxyHealthy = await this.checkHttpHealth(`http://${proxyHost}:${proxyPort}/health`, 3000);

      if (!proxyHealthy) {
        // WARN only — do not mark mastra as unhealthy (D-15: non-blocking)
        this.log('Mastra agent running but LLM proxy unreachable — warning only (non-blocking per D-15)', 'WARN');
        return {
          success: true,
          message: `Mastra agent running (sessions: ${mastraSessions || 'via ps'}). LLM proxy on port ${proxyPort} unreachable — warning only.`
        };
      }

      return {
        success: true,
        message: `Mastra agent healthy (sessions: ${mastraSessions || 'via ps'}, LLM proxy OK)`
      };

    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Helper: Check HTTP health endpoint
   */
  async checkHttpHealth(url, timeoutMs = 3000) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeout);
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Helper: Check if port is listening
   */
  async checkPortListening(port) {
    try {
      const { stdout } = await execAsync(`lsof -i :${port} -P -n | grep LISTEN`);
      return stdout.trim().length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Helper: Check if process is alive
   */
  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Docker helper: Restart a service via supervisorctl
   * Uses the DOCKER_SERVICE_MAP to translate action names to supervisor program names
   */
  async supervisorctlRestart(actionName, verifyEndpoint) {
    const programName = DOCKER_SERVICE_MAP[actionName];
    if (!programName) {
      return { success: false, message: `No Docker service mapping for: ${actionName}` };
    }

    try {
      this.log(`Docker: supervisorctl restart ${programName}`);
      await execAsync(`supervisorctl restart ${programName}`, { timeout: 15000 });
      await this.sleep(3000);

      // Verify the service is running
      if (verifyEndpoint) {
        try {
          const response = await fetch(verifyEndpoint, {
            method: 'GET',
            signal: AbortSignal.timeout(3000)
          });
          if (response.ok) {
            return { success: true, message: `Docker: ${programName} restarted via supervisorctl` };
          }
        } catch (verifyError) {
          // Verify failed but service might still be starting
        }
      }

      // Check supervisor status as fallback
      const { stdout } = await execAsync(`supervisorctl status ${programName}`, { timeout: 5000 });
      const isRunning = stdout.includes('RUNNING');
      return {
        success: isRunning,
        message: isRunning
          ? `Docker: ${programName} restarted via supervisorctl`
          : `Docker: ${programName} restart failed - status: ${stdout.trim()}`
      };
    } catch (error) {
      return { success: false, message: `Docker supervisorctl error: ${error.message}` };
    }
  }

  /**
   * Helper: Sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default HealthRemediationActions;
