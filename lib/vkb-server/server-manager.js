/**
 * Server Manager - Handles HTTP server lifecycle
 */

import { spawn, exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { Logger } from './utils/logging.js';

const execAsync = promisify(exec);

export class ServerManager {
  constructor(options) {
    this.port = options.port;
    this.pidFile = options.pidFile;
    this.logFile = options.logFile;
    this.visualizerDir = options.visualizerDir;
    this.logger = new Logger('ServerManager');
  }
  
  /**
   * Check if server is running
   */
  async isRunning() {
    // Check PID file
    const pid = await this.getPid();
    if (pid && await this.isProcessRunning(pid)) {
      return true;
    }
    
    // Check if port is in use
    return await this.isPortInUse();
  }
  
  /**
   * Get server PID from file
   */
  async getPid() {
    try {
      const pidStr = await fs.readFile(this.pidFile, 'utf8');
      return parseInt(pidStr.trim(), 10);
    } catch {
      return null;
    }
  }
  
  /**
   * Check if a process is running
   */
  async isProcessRunning(pid) {
    try {
      // Send signal 0 to check if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Check if port is in use
   */
  async isPortInUse() {
    try {
      // Try using lsof first (most reliable)
      const { stdout } = await execAsync(`lsof -i :${this.port} -sTCP:LISTEN`, {
        encoding: 'utf8'
      });
      return stdout.trim().length > 0;
    } catch {
      // lsof failed, try netstat
      try {
        const { stdout } = await execAsync(`netstat -an | grep ":${this.port}" | grep LISTEN`, {
          encoding: 'utf8'
        });
        return stdout.trim().length > 0;
      } catch {
        // Both failed, assume port is free
        return false;
      }
    }
  }
  
  /**
   * Start the HTTP server
   */
  async start(options = {}) {
    const { foreground = false } = options;
    
    // Check for Python 3
    try {
      await execAsync('python3 --version');
    } catch {
      throw new Error('Python 3 is required but not found');
    }
    
    // Check for API server first, then CORS server
    const apiServerPath = path.join(this.visualizerDir, 'api-server.py');
    const corsServerPath = path.join(this.visualizerDir, 'cors-server.py');
    const hasApiServer = await this.fileExists(apiServerPath);
    const hasCorsServer = await this.fileExists(corsServerPath);
    
    // Build command - prefer API server for team management
    const command = hasApiServer
      ? ['python3', apiServerPath, String(this.port), 'dist']
      : hasCorsServer
      ? ['python3', corsServerPath, String(this.port), 'dist']
      : ['python3', '-m', 'http.server', String(this.port), '--directory', 'dist'];
    
    if (foreground) {
      // Run in foreground - this will block
      const child = spawn(command[0], command.slice(1), {
        stdio: 'inherit',
        cwd: this.visualizerDir
      });
      
      // This won't return until the process exits
      return new Promise((resolve) => {
        child.on('exit', (code) => {
          resolve({ success: code === 0 });
        });
      });
    } else {
      // Run in background
      const logStream = await fs.open(this.logFile, 'w');
      
      const child = spawn(command[0], command.slice(1), {
        detached: true,
        stdio: ['ignore', logStream, logStream],
        cwd: this.visualizerDir
      });
      
      // Save PID
      await fs.writeFile(this.pidFile, String(child.pid));
      
      // Detach from parent
      child.unref();
      
      // Wait a moment and verify it started
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      if (!await this.isProcessRunning(child.pid)) {
        throw new Error('Server failed to start');
      }
      
      // Verify server is responding
      await this.waitForServer();
      
      return { success: true, pid: child.pid };
    }
  }
  
  /**
   * Stop the server
   */
  async stop() {
    // Try to stop using PID file
    const pid = await this.getPid();
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Force kill if still running
        if (await this.isProcessRunning(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        // Process might already be dead
      }
      
      // Remove PID file
      try {
        await fs.unlink(this.pidFile);
      } catch {
        // File might not exist
      }
    }
    
    // Kill any remaining processes on the port
    await this.killProcessesOnPort();
    
    return { success: true };
  }
  
  /**
   * Kill all processes using the port
   */
  async killProcessesOnPort() {
    try {
      const { stdout } = await execAsync(`lsof -ti:${this.port}`, {
        encoding: 'utf8'
      });
      
      const pids = stdout.trim().split('\n').filter(pid => pid);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGKILL');
        } catch {
          // Process might already be dead
        }
      }
    } catch {
      // lsof might fail if no processes found
    }
  }
  
  /**
   * Wait for server to become responsive
   */
  async waitForServer(maxAttempts = 10) {
    const fetch = (await import('node-fetch')).default;
    
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`http://localhost:${this.port}`);
        if (response.ok) {
          return true;
        }
      } catch {
        // Server not ready yet
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error('Server failed to become responsive');
  }
  
  /**
   * Get server logs
   */
  async getLogs(options = {}) {
    const { lines = 20, follow = false } = options;
    
    try {
      if (follow) {
        // For follow mode, we'd need to implement tailing
        throw new Error('Follow mode not implemented');
      } else {
        const { stdout } = await execAsync(`tail -n ${lines} "${this.logFile}"`, {
          encoding: 'utf8'
        });
        return stdout;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return 'No log file found';
      }
      throw error;
    }
  }
  
  /**
   * Check if file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}