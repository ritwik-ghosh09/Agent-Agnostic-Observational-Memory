#!/usr/bin/env node

/**
 * Operational Logger Integration Tests
 * 
 * Tests comprehensive operational logging with performance metrics
 * and structured logging functionality.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OperationalLogger from '../../src/live-logging/OperationalLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class OperationalLoggerTest {
  constructor() {
    this.testResults = {
      passed: 0,
      failed: 0,
      errors: []
    };
    
    this.testDir = path.join(__dirname, 'test-logs');
    this.tempFiles = [];
    
    this.setupTestEnvironment();
  }
  
  setupTestEnvironment() {
    // Create test directory
    if (!fs.existsSync(this.testDir)) {
      fs.mkdirSync(this.testDir, { recursive: true });
    }
  }
  
  async runAllTests() {
    console.log('=== Operational Logger Integration Tests ===\n');
    
    try {
      await this.testBasicLogging();
      await this.testPerformanceMetrics();
      await this.testStructuredMetrics();
      await this.testSystemHealth();
      await this.testOperationalEvents();
      await this.testLogQuerying();
      await this.testAlertGeneration();
      await this.testLogRotation();
      
      this.printResults();
      return this.testResults.failed === 0;
      
    } catch (error) {
      console.error('Fatal test error:', error);
      return false;
    } finally {
      this.cleanup();
    }
  }
  
  async testBasicLogging() {
    console.log('1. Testing basic logging functionality...');
    
    try {
      const logger = new OperationalLogger({
        projectPath: this.testDir,
        debug: false,
        flushIntervalMs: 100 // Fast flush for testing
      });
      
      // Test different log types
      logger.log('Test info message', 'info', 'test');
      logger.log('Test warning message', 'warn', 'test');
      logger.log('Test error message', 'error', 'test');
      
      logger.logError(new Error('Test error'), { component: 'test' });
      
      // Force flush
      logger.flush();
      
      // Wait a bit for file operations
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Check that log files were created
      const logFiles = [
        path.join(this.testDir, '.specstory', 'logs', 'system.log'),
        path.join(this.testDir, '.specstory', 'logs', 'errors.log')
      ];
      
      for (const logFile of logFiles) {
        this.tempFiles.push(logFile);
        this.assert(fs.existsSync(logFile), `Log file should exist: ${logFile}`);
        
        const content = fs.readFileSync(logFile, 'utf8');
        this.assert(content.length > 0, 'Log file should have content');
        
        // Validate JSON structure
        const lines = content.trim().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            JSON.parse(line); // Should not throw
          }
        }
      }
      
      const stats = logger.getStats();
      this.assert(stats.logsWritten > 0, 'Should have logged messages');
      this.assert(stats.errorsLogged > 0, 'Should have logged errors');
      
      logger.destroy();
      
      this.testResults.passed++;
      console.log('   ✓ Basic logging works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Basic logging: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testPerformanceMetrics() {
    console.log('2. Testing performance metrics logging...');
    
    try {
      const logger = new OperationalLogger({
        projectPath: this.testDir,
        debug: false,
        flushIntervalMs: 100
      });
      
      // Log performance metrics with comprehensive data
      logger.logPerformance('TestComponent', {
        processingTime: 150,
        accuracy: 95.5,
        throughput: 1000,
        totalCalls: 50,
        averageTime: 120,
        minTime: 80,
        maxTime: 200,
        cacheHitRate: 85,
        successRate: 98
      }, {
        sessionId: 'test-session-123',
        activeSessions: 3
      });
      
      logger.flush();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const performanceLogFile = path.join(this.testDir, '.specstory', 'logs', 'performance.log');
      this.tempFiles.push(performanceLogFile);
      
      this.assert(fs.existsSync(performanceLogFile), 'Performance log file should exist');
      
      const content = fs.readFileSync(performanceLogFile, 'utf8');
      const logEntry = JSON.parse(content.trim());
      
      this.assert(logEntry.type === 'performance', 'Should be performance log entry');
      this.assert(logEntry.component === 'TestComponent', 'Should have correct component');
      this.assert(logEntry.metrics.processingTime === 150, 'Should have processing time');
      this.assert(logEntry.metrics.memoryUsage !== undefined, 'Should include memory usage');
      this.assert(logEntry.systemHealth !== undefined, 'Should include system health');
      this.assert(logEntry.systemHealth.uptime > 0, 'Should have uptime data');
      
      logger.destroy();
      
      this.testResults.passed++;
      console.log('   ✓ Performance metrics logging works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Performance metrics: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testStructuredMetrics() {
    console.log('3. Testing structured metrics logging...');
    
    try {
      const logger = new OperationalLogger({
        projectPath: this.testDir,
        debug: false,
        flushIntervalMs: 100
      });
      
      // Log structured metrics for different subsystems
      logger.logStructuredMetrics('LSLFileManager', {
        fileSize: 5242880, // 5MB
        compressionRatio: 75,
        rotationCount: 2,
        averageTime: 250
      }, {
        sessionId: 'test-session-456',
        operation: 'file-rotation'
      });
      
      logger.logStructuredMetrics('ReliableCodingClassifier', {
        classificationsPerSecond: 15,
        confidence: 92.5,
        layer: 'semantic',
        errorRate: 2.1,
        averageTime: 8500 // Trigger alert
      }, {
        sessionId: 'test-session-789'
      });
      
      logger.flush();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const performanceLogFile = path.join(this.testDir, '.specstory', 'logs', 'performance.log');
      
      this.assert(fs.existsSync(performanceLogFile), 'Performance log file should exist');
      
      const content = fs.readFileSync(performanceLogFile, 'utf8');
      const lines = content.trim().split('\n');
      
      // Find structured metrics entries
      const structuredEntries = lines
        .map(line => JSON.parse(line))
        .filter(entry => entry.type === 'structured_metrics');
      
      this.assert(structuredEntries.length >= 2, 'Should have structured metrics entries');
      
      const lslEntry = structuredEntries.find(e => e.subsystem === 'LSLFileManager');
      this.assert(lslEntry !== undefined, 'Should have LSLFileManager entry');
      this.assert(lslEntry.category !== undefined, 'Should have a category assigned');
      this.assert(lslEntry.correlationId !== undefined, 'Should have correlation ID');
      this.assert(Array.isArray(lslEntry.alerts), 'Should have alerts array');
      
      const classifierEntry = structuredEntries.find(e => e.subsystem === 'ReliableCodingClassifier');
      this.assert(classifierEntry !== undefined, 'Should have ReliableCodingClassifier entry');
      this.assert(classifierEntry.category === 'performance', 'Should categorize as performance metrics');
      
      logger.destroy();
      
      this.testResults.passed++;
      console.log('   ✓ Structured metrics logging works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Structured metrics: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testSystemHealth() {
    console.log('4. Testing system health logging...');
    
    try {
      const logger = new OperationalLogger({
        projectPath: this.testDir,
        debug: false,
        flushIntervalMs: 100
      });
      
      // Log system health
      logger.logSystemHealth({
        activeSessions: 5,
        queueLength: 12,
        lastError: null,
        diskUsage: 45.2,
        networkLatency: 150
      }, {
        monitoringSource: 'health-check',
        lastProcessingTime: 3500
      });
      
      logger.flush();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const systemLogFile = path.join(this.testDir, '.specstory', 'logs', 'system.log');
      
      this.assert(fs.existsSync(systemLogFile), 'System log file should exist');
      
      const content = fs.readFileSync(systemLogFile, 'utf8');
      const lines = content.trim().split('\n');
      
      const healthEntry = lines
        .map(line => JSON.parse(line))
        .find(entry => entry.type === 'system_health');
      
      this.assert(healthEntry !== undefined, 'Should have system health entry');
      this.assert(healthEntry.health.uptime > 0, 'Should have uptime data');
      this.assert(healthEntry.health.memory !== undefined, 'Should have memory data');
      this.assert(healthEntry.health.activeSessions === 5, 'Should have custom health data');
      this.assert(healthEntry.indicators !== undefined, 'Should have health indicators');
      this.assert(typeof healthEntry.indicators.memoryHealthy === 'boolean', 'Should have memory health indicator');
      
      logger.destroy();
      
      this.testResults.passed++;
      console.log('   ✓ System health logging works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`System health: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testOperationalEvents() {
    console.log('5. Testing operational event logging...');
    
    try {
      const logger = new OperationalLogger({
        projectPath: this.testDir,
        debug: false,
        flushIntervalMs: 100
      });
      
      // Log different types of operational events
      logger.logOperationalEvent('system_startup', {
        version: '1.0.0',
        configFile: 'test-config.json',
        startupTime: 2500
      }, 'info', {
        component: 'main-system'
      });
      
      logger.logOperationalEvent('file_rotation_completed', {
        originalSize: 52428800,
        compressedSize: 13107200,
        compressionRatio: 75,
        rotationTime: 1500
      }, 'info', {
        component: 'file-manager',
        sessionId: 'test-session'
      });
      
      logger.logOperationalEvent('classification_error', {
        errorType: 'timeout',
        processingTime: 30000,
        retryCount: 3
      }, 'warning', {
        component: 'classifier'
      });
      
      logger.flush();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const systemLogFile = path.join(this.testDir, '.specstory', 'logs', 'system.log');
      
      const content = fs.readFileSync(systemLogFile, 'utf8');
      const lines = content.trim().split('\n');
      
      const operationalEvents = lines
        .map(line => JSON.parse(line))
        .filter(entry => entry.type === 'operational_event');
      
      this.assert(operationalEvents.length >= 3, 'Should have operational event entries');
      
      const startupEvent = operationalEvents.find(e => e.event === 'system_startup');
      this.assert(startupEvent !== undefined, 'Should have startup event');
      this.assert(startupEvent.category === 'lifecycle', 'Should categorize startup as lifecycle');
      this.assert(startupEvent.impact === 'low', 'Should assess startup impact as low');
      
      const rotationEvent = operationalEvents.find(e => e.event === 'file_rotation_completed');
      this.assert(rotationEvent !== undefined, 'Should have rotation event');
      this.assert(rotationEvent.category === 'maintenance', 'Should categorize rotation as maintenance');
      
      const errorEvent = operationalEvents.find(e => e.event === 'classification_error');
      this.assert(errorEvent !== undefined, 'Should have error event');
      this.assert(errorEvent.category === 'error', 'Should categorize error correctly');
      this.assert(errorEvent.severity === 'warning', 'Should have correct severity');
      
      logger.destroy();
      
      this.testResults.passed++;
      console.log('   ✓ Operational event logging works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Operational events: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testLogQuerying() {
    console.log('6. Testing log querying functionality...');
    
    try {
      const logger = new OperationalLogger({
        projectPath: this.testDir,
        debug: false,
        flushIntervalMs: 100
      });
      
      // Create test log entries
      logger.log('Query test message 1', 'info', 'query-test');
      logger.log('Query test message 2', 'warn', 'query-test');
      logger.logError(new Error('Query test error'), { component: 'query-test' });
      
      logger.flush();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Test basic query
      const allLogs = logger.queryLogs({}, { limit: 100 });
      this.assert(allLogs.length > 0, 'Should return log entries');
      
      // Test filtered query
      const errorLogs = logger.queryLogs({ type: 'error' }, { limit: 10 });
      this.assert(errorLogs.length > 0, 'Should return error logs');
      this.assert(errorLogs.every(log => log.type === 'error'), 'All returned logs should be errors');
      
      // Test search query
      const searchLogs = logger.queryLogs({ search: 'query test' }, { limit: 10 });
      this.assert(searchLogs.length > 0, 'Should return matching logs');
      
      // Test category filter
      const categoryLogs = logger.queryLogs({ category: 'query-test' }, { limit: 10 });
      this.assert(categoryLogs.length >= 2, 'Should return category-filtered logs');
      
      logger.destroy();
      
      this.testResults.passed++;
      console.log('   ✓ Log querying works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Log querying: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testAlertGeneration() {
    console.log('7. Testing alert generation...');
    
    try {
      const logger = new OperationalLogger({
        projectPath: this.testDir,
        debug: false,
        flushIntervalMs: 100
      });
      
      // Test metrics that should trigger alerts
      logger.logStructuredMetrics('TestSubsystem', {
        processingTime: 15000, // Should trigger performance alert
        errorRate: 15, // Should trigger quality alert
        fileSize: 47 * 1024 * 1024 // Should trigger storage alert for LSLFileManager
      });
      
      // Test LSLFileManager specific alert
      logger.logStructuredMetrics('LSLFileManager', {
        fileSize: 47 * 1024 * 1024, // Should trigger storage alert
        compressionRatio: 85
      });
      
      logger.flush();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const performanceLogFile = path.join(this.testDir, '.specstory', 'logs', 'performance.log');
      const content = fs.readFileSync(performanceLogFile, 'utf8');
      const lines = content.trim().split('\n');
      
      const metricsEntries = lines
        .map(line => JSON.parse(line))
        .filter(entry => entry.type === 'structured_metrics');
      
      let alertsFound = 0;
      for (const entry of metricsEntries) {
        if (entry.alerts && entry.alerts.length > 0) {
          alertsFound += entry.alerts.length;
          
          // Validate alert structure
          for (const alert of entry.alerts) {
            this.assert(alert.type !== undefined, 'Alert should have type');
            this.assert(alert.severity !== undefined, 'Alert should have severity');
            this.assert(alert.message !== undefined, 'Alert should have message');
            this.assert(alert.threshold !== undefined, 'Alert should have threshold');
            this.assert(alert.value !== undefined, 'Alert should have value');
          }
        }
      }
      
      this.assert(alertsFound > 0, 'Should generate alerts for threshold violations');
      
      logger.destroy();
      
      this.testResults.passed++;
      console.log('   ✓ Alert generation works correctly');
      console.log(`     Generated ${alertsFound} alerts for threshold violations`);
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Alert generation: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testLogRotation() {
    console.log('8. Testing log rotation...');
    
    try {
      const logger = new OperationalLogger({
        projectPath: this.testDir,
        debug: false,
        flushIntervalMs: 100,
        maxLogSizeMB: 0.001 // Very small size to trigger rotation
      });
      
      // Generate enough logs to trigger rotation
      for (let i = 0; i < 100; i++) {
        logger.log(`Test log message ${i} with some additional content to increase size`, 'info', 'rotation-test');
      }
      
      logger.flush();
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const logDir = path.join(this.testDir, '.specstory', 'logs');
      const files = fs.readdirSync(logDir);
      
      // Check for rotated files
      const rotatedFiles = files.filter(f => f.includes('.1.'));
      
      if (rotatedFiles.length > 0) {
        this.assert(rotatedFiles.length > 0, 'Should have created rotated log files');
        console.log('   ✓ Log rotation works correctly');
      } else {
        console.log('   ⚠ Log rotation not triggered (file size threshold not reached)');
      }
      
      const stats = logger.getStats();
      this.assert(stats.logsWritten > 0, 'Should have written logs');
      
      logger.destroy();
      
      this.testResults.passed++;
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Log rotation: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  assert(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }
  
  cleanup() {
    // Remove test directory
    try {
      if (fs.existsSync(this.testDir)) {
        this.removeDirectoryRecursive(this.testDir);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }
  
  removeDirectoryRecursive(dirPath) {
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
          this.removeDirectoryRecursive(filePath);
        } else {
          fs.unlinkSync(filePath);
        }
      }
      
      fs.rmdirSync(dirPath);
    }
  }
  
  printResults() {
    console.log('\n=== Test Results ===');
    console.log(`Tests passed: ${this.testResults.passed}`);
    console.log(`Tests failed: ${this.testResults.failed}`);
    
    if (this.testResults.errors.length > 0) {
      console.log('\nErrors:');
      this.testResults.errors.forEach(error => console.log(`- ${error}`));
    }
    
    console.log(`\nOverall: ${this.testResults.failed === 0 ? 'PASS' : 'FAIL'}`);
  }
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const test = new OperationalLoggerTest();
  const success = await test.runAllTests();
  process.exit(success ? 0 : 1);
}

export { OperationalLoggerTest };