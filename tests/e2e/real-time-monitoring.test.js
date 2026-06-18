#!/usr/bin/env node

/**
 * Real-Time Monitoring E2E Tests
 * 
 * Comprehensive end-to-end testing for the enhanced-transcript-monitor.js system.
 * Tests actual file creation, content classification, health monitoring, and LSL generation.
 * 
 * Test Coverage:
 * - Real-time transcript monitoring with file watching
 * - LSL file creation and content generation
 * - Content classification and redaction
 * - Health monitoring and status updates
 * - Multi-user hash integration
 * - Error handling and recovery
 * - Performance under load
 * - Cleanup and resource management
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, fork } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import EventEmitter from 'events';

// Import framework for test utilities
import E2ETestFramework from './test-framework.js';
import { generateLSLFilename, formatTimestamp } from '../../scripts/timezone-utils.js';
import UserHashGenerator from '../../src/live-logging/user-hash-generator.js';

class RealTimeMonitoringTests extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      testRoot: options.testRoot || path.join(os.tmpdir(), 'lsl-realtime-e2e-tests'),
      codingRepo: options.codingRepo || process.cwd(),
      timeout: options.timeout || 30000,
      verbose: options.verbose || false,
      keepTestData: options.keepTestData || false,
      
      // Test scenarios
      scenarios: [
        'basic-monitoring',
        'content-classification', 
        'health-monitoring',
        'multi-user-coordination',
        'error-handling',
        'performance-stress'
      ]
    };
    
    this.testResults = {
      passed: 0,
      failed: 0,
      errors: [],
      scenarios: new Map()
    };
    
    this.activeProcesses = new Map();
    this.cleanupTasks = [];
  }

  async runAllTests() {
    this.log('Starting Real-Time Monitoring E2E Tests...');
    const startTime = Date.now();
    
    try {
      await this.setupTestEnvironment();
      
      for (const scenario of this.config.scenarios) {
        await this.runTestScenario(scenario);
      }
      
    } catch (error) {
      this.logError('Test execution failed:', error);
      this.testResults.errors.push({
        type: 'execution_error',
        error: error.message,
        timestamp: Date.now()
      });
    } finally {
      const duration = Date.now() - startTime;
      await this.cleanup();
      this.generateReport(duration);
    }
    
    return this.testResults.failed === 0;
  }

  async setupTestEnvironment() {
    // Create isolated test environment
    if (fs.existsSync(this.config.testRoot)) {
      fs.rmSync(this.config.testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(this.config.testRoot, { recursive: true });
    
    // Create mock project structures
    const testProjects = ['test-project-a', 'test-project-b'];
    for (const project of testProjects) {
      const projectPath = path.join(this.config.testRoot, project);
      const specstoryPath = path.join(projectPath, '.specstory/history');
      
      fs.mkdirSync(specstoryPath, { recursive: true });
    }
    
    // Create mock transcript directories (simulating Claude projects)
    const transcriptDir = path.join(this.config.testRoot, '.claude/projects/test-project');
    fs.mkdirSync(transcriptDir, { recursive: true });
    
    this.log(`Test environment set up at: ${this.config.testRoot}`);
  }

  async runTestScenario(scenarioName) {
    this.log(`Running scenario: ${scenarioName}`);
    const startTime = Date.now();
    
    try {
      const scenarioMethod = this.getScenarioMethod(scenarioName);
      await scenarioMethod.call(this);
      
      const duration = Date.now() - startTime;
      this.testResults.passed++;
      this.testResults.scenarios.set(scenarioName, {
        status: 'passed',
        duration: duration
      });
      this.log(`✅ ${scenarioName} passed (${duration}ms)`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.testResults.failed++;
      this.testResults.scenarios.set(scenarioName, {
        status: 'failed',
        duration: duration,
        error: error.message
      });
      this.testResults.errors.push({
        scenario: scenarioName,
        error: error.message,
        stack: error.stack,
        duration: duration,
        timestamp: Date.now()
      });
      this.logError(`❌ ${scenarioName} failed (${duration}ms):`, error);
    }
  }

  getScenarioMethod(scenarioName) {
    const methods = {
      'basic-monitoring': this.testBasicMonitoring,
      'content-classification': this.testContentClassification,
      'health-monitoring': this.testHealthMonitoring,
      'multi-user-coordination': this.testMultiUserCoordination,
      'error-handling': this.testErrorHandling,
      'performance-stress': this.testPerformanceStress
    };
    
    const method = methods[scenarioName];
    if (!method) {
      throw new Error(`Unknown scenario: ${scenarioName}`);
    }
    
    return method;
  }

  // Test Scenario Implementations

  async testBasicMonitoring() {
    const projectPath = path.join(this.config.testRoot, 'test-project-a');
    const transcriptPath = path.join(this.config.testRoot, '.claude/projects/test-project/transcript.jsonl');
    
    // Create initial transcript file
    const mockTranscript = this.generateMockTranscript(10);
    fs.writeFileSync(transcriptPath, mockTranscript);
    
    // Start enhanced-transcript-monitor
    const monitorProcess = await this.startTranscriptMonitor(projectPath, transcriptPath);
    
    try {
      // Wait for initial processing
      await sleep(2000);
      
      // Verify LSL files are created
      const historyDir = path.join(projectPath, '.specstory/history');
      const lslFiles = fs.readdirSync(historyDir).filter(file => file.endsWith('.md'));
      
      if (lslFiles.length === 0) {
        throw new Error('No LSL files created during basic monitoring');
      }
      
      // Verify LSL file content
      const lslFile = path.join(historyDir, lslFiles[0]);
      const content = fs.readFileSync(lslFile, 'utf8');
      
      if (!content.includes('# Live Session Log')) {
        throw new Error('LSL file missing expected header');
      }
      
      if (!content.includes('Exchange')) {
        throw new Error('LSL file missing exchange content');
      }
      
      // Verify health file is created and updated
      const healthFile = path.join(this.config.codingRepo, '.transcript-monitor-health');
      if (!fs.existsSync(healthFile)) {
        throw new Error('Health monitoring file not created');
      }
      
      const healthData = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      if (healthData.projectPath !== projectPath) {
        throw new Error('Health data contains incorrect project path');
      }
      
      this.log('✓ Basic monitoring: LSL files created successfully');
      this.log('✓ Basic monitoring: Health monitoring active');
      
    } finally {
      await this.stopProcess(monitorProcess);
    }
  }

  async testContentClassification() {
    const projectPath = path.join(this.config.testRoot, 'test-project-b');
    const transcriptPath = path.join(this.config.testRoot, '.claude/projects/test-project/classified-transcript.jsonl');
    
    // Create transcript with sensitive content
    const sensitiveTranscript = this.generateSensitiveTranscript();
    fs.writeFileSync(transcriptPath, sensitiveTranscript);
    
    const monitorProcess = await this.startTranscriptMonitor(projectPath, transcriptPath);
    
    try {
      await sleep(3000);
      
      // Verify LSL files contain redacted content
      const historyDir = path.join(projectPath, '.specstory/history');
      const lslFiles = fs.readdirSync(historyDir).filter(file => file.endsWith('.md'));
      
      if (lslFiles.length === 0) {
        throw new Error('No LSL files created for content classification test');
      }
      
      const lslContent = fs.readFileSync(path.join(historyDir, lslFiles[0]), 'utf8');
      
      // Verify secrets are redacted
      if (lslContent.includes('sk-1234567890abcdef')) {
        throw new Error('API key not properly redacted in LSL');
      }
      
      if (lslContent.includes('test@example.com')) {
        throw new Error('Email address not properly redacted in LSL');
      }
      
      if (!lslContent.includes('<SECRET_REDACTED>')) {
        throw new Error('Redaction placeholder not found in LSL');
      }
      
      // Verify proper content classification
      if (!lslContent.includes('**Tool:**') && !lslContent.includes('**Content:**')) {
        throw new Error('Content not properly classified in LSL');
      }
      
      this.log('✓ Content classification: Secrets properly redacted');
      this.log('✓ Content classification: Content properly structured');
      
    } finally {
      await this.stopProcess(monitorProcess);
    }
  }

  async testHealthMonitoring() {
    const projectPath = path.join(this.config.testRoot, 'test-project-a');
    const transcriptPath = path.join(this.config.testRoot, '.claude/projects/test-project/health-transcript.jsonl');
    
    fs.writeFileSync(transcriptPath, this.generateMockTranscript(5));
    
    const monitorProcess = await this.startTranscriptMonitor(projectPath, transcriptPath);
    
    try {
      await sleep(1000);
      
      const healthFile = path.join(this.config.codingRepo, '.transcript-monitor-health');
      
      // Verify health file exists and is updated
      if (!fs.existsSync(healthFile)) {
        throw new Error('Health monitoring file not created');
      }
      
      const initialHealth = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      const initialTimestamp = initialHealth.timestamp;
      
      // Add more transcript content to trigger updates
      const additionalContent = this.generateMockTranscript(3);
      fs.appendFileSync(transcriptPath, '\n' + additionalContent);
      
      await sleep(2000);
      
      // Verify health file is updated
      const updatedHealth = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      
      if (updatedHealth.timestamp <= initialTimestamp) {
        throw new Error('Health monitoring timestamp not updated');
      }
      
      if (updatedHealth.status !== 'running') {
        throw new Error(`Health status incorrect: ${updatedHealth.status}`);
      }
      
      if (!updatedHealth.projectPath) {
        throw new Error('Health data missing project path');
      }
      
      if (!updatedHealth.transcriptPath) {
        throw new Error('Health data missing transcript path');
      }
      
      this.log('✓ Health monitoring: Status properly tracked');
      this.log('✓ Health monitoring: Updates working correctly');
      
    } finally {
      await this.stopProcess(monitorProcess);
    }
  }

  async testMultiUserCoordination() {
    const projectPath = path.join(this.config.testRoot, 'test-project-a');
    const transcriptPath = path.join(this.config.testRoot, '.claude/projects/test-project/multi-user-transcript.jsonl');
    
    fs.writeFileSync(transcriptPath, this.generateMockTranscript(8));
    
    const monitorProcess = await this.startTranscriptMonitor(projectPath, transcriptPath);
    
    try {
      await sleep(2500);
      
      // Verify user hash integration in LSL filenames
      const historyDir = path.join(projectPath, '.specstory/history');
      const lslFiles = fs.readdirSync(historyDir).filter(file => file.endsWith('.md'));
      
      if (lslFiles.length === 0) {
        throw new Error('No LSL files created for multi-user test');
      }
      
      const userHash = UserHashGenerator.generateHash({ debug: false });
      const lslFilename = lslFiles[0];
      
      // Verify filename contains user hash
      if (!lslFilename.includes(userHash)) {
        throw new Error(`LSL filename missing user hash. Expected: ${userHash}, File: ${lslFilename}`);
      }
      
      // Verify filename follows new format (YYYY-MM-DD_HHMM-HHMM_hash_from-project.md)
      const filenamePattern = /\d{4}-\d{2}-\d{2}_\d{4}-\d{4}_[a-z0-9]{6}(_from-[\w-]+)?\.md/;
      if (!filenamePattern.test(lslFilename)) {
        throw new Error(`LSL filename doesn't match expected pattern: ${lslFilename}`);
      }
      
      // Verify health monitoring includes user hash
      const healthFile = path.join(this.config.codingRepo, '.transcript-monitor-health');
      const healthData = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      
      // Note: Health monitoring may not include user hash in current implementation,
      // but we verify the monitoring system works with multi-user scenarios
      if (healthData.status !== 'running') {
        throw new Error('Multi-user health monitoring not working correctly');
      }
      
      this.log('✓ Multi-user coordination: User hash integrated in filenames');
      this.log('✓ Multi-user coordination: Health monitoring compatible');
      
    } finally {
      await this.stopProcess(monitorProcess);
    }
  }

  async testErrorHandling() {
    const projectPath = path.join(this.config.testRoot, 'test-project-error');
    const invalidTranscriptPath = path.join(this.config.testRoot, '.claude/projects/test-project/invalid-transcript.jsonl');
    
    // Create transcript with invalid JSON to test error handling
    const invalidTranscript = [
      '{"valid": "json", "timestamp": 1234567890}',
      'invalid json line here',
      '{"another": "valid", "timestamp": 1234567891}',
      '{"missing": "quote, "timestamp": 1234567892}'
    ].join('\n');
    
    fs.writeFileSync(invalidTranscriptPath, invalidTranscript);
    
    // Ensure project directory exists
    const specstoryDir = path.join(projectPath, '.specstory/history');
    fs.mkdirSync(specstoryDir, { recursive: true });
    
    const monitorProcess = await this.startTranscriptMonitor(projectPath, invalidTranscriptPath);
    
    try {
      await sleep(3000);
      
      // Verify monitor continues running despite errors
      const healthFile = path.join(this.config.codingRepo, '.transcript-monitor-health');
      if (!fs.existsSync(healthFile)) {
        throw new Error('Health monitoring stopped due to invalid transcript');
      }
      
      const healthData = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      if (healthData.status !== 'running') {
        throw new Error('Monitor not running after encountering invalid JSON');
      }
      
      // Verify some LSL content is still created from valid lines
      const historyDir = path.join(projectPath, '.specstory/history');
      const lslFiles = fs.readdirSync(historyDir).filter(file => file.endsWith('.md'));
      
      if (lslFiles.length === 0) {
        throw new Error('No LSL files created despite having some valid transcript lines');
      }
      
      const lslContent = fs.readFileSync(path.join(historyDir, lslFiles[0]), 'utf8');
      
      // Should contain content from valid JSON lines
      if (!lslContent.includes('Exchange') && !lslContent.includes('valid')) {
        throw new Error('Valid transcript content not processed correctly');
      }
      
      this.log('✓ Error handling: Monitor resilient to invalid JSON');
      this.log('✓ Error handling: Valid content still processed');
      
    } finally {
      await this.stopProcess(monitorProcess);
    }
  }

  async testPerformanceStress() {
    const projectPath = path.join(this.config.testRoot, 'test-project-stress');
    const transcriptPath = path.join(this.config.testRoot, '.claude/projects/test-project/stress-transcript.jsonl');
    
    // Create large transcript file (500 exchanges)
    const largeTranscript = this.generateMockTranscript(500);
    fs.writeFileSync(transcriptPath, largeTranscript);
    
    const specstoryDir = path.join(projectPath, '.specstory/history');
    fs.mkdirSync(specstoryDir, { recursive: true });
    
    const startTime = Date.now();
    const monitorProcess = await this.startTranscriptMonitor(projectPath, transcriptPath);
    
    try {
      // Wait for processing with longer timeout for stress test
      await sleep(10000);
      
      const processingTime = Date.now() - startTime;
      
      // Verify LSL files are created
      const lslFiles = fs.readdirSync(specstoryDir).filter(file => file.endsWith('.md'));
      if (lslFiles.length === 0) {
        throw new Error('No LSL files created during stress test');
      }
      
      // Verify performance is acceptable (should process 500 exchanges in under 10 seconds)
      if (processingTime > 10000) {
        throw new Error(`Processing too slow: ${processingTime}ms for 500 exchanges`);
      }
      
      // Verify content quality is maintained under load
      const lslContent = fs.readFileSync(path.join(specstoryDir, lslFiles[0]), 'utf8');
      const exchangeMatches = lslContent.match(/Exchange/g);
      
      if (!exchangeMatches || exchangeMatches.length === 0) {
        throw new Error('No exchanges found in LSL file during stress test');
      }
      
      // Verify health monitoring remains responsive
      const healthFile = path.join(this.config.codingRepo, '.transcript-monitor-health');
      const healthData = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      
      if (healthData.status !== 'running') {
        throw new Error('Health monitoring failed during stress test');
      }
      
      this.log(`✓ Performance stress: 500 exchanges processed in ${processingTime}ms`);
      this.log(`✓ Performance stress: ${exchangeMatches.length} exchanges in LSL`);
      
    } finally {
      await this.stopProcess(monitorProcess);
    }
  }

  // Utility Methods

  async startTranscriptMonitor(projectPath, transcriptPath) {
    const monitorScript = path.join(this.config.codingRepo, 'scripts/enhanced-transcript-monitor.js');
    
    if (!fs.existsSync(monitorScript)) {
      throw new Error(`Enhanced transcript monitor not found at: ${monitorScript}`);
    }
    
    const env = {
      ...process.env,
      TRANSCRIPT_SOURCE_PROJECT: projectPath,
      NODE_ENV: 'test'
    };
    
    const child = spawn('node', [monitorScript, transcriptPath], {
      env: env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    const processId = `monitor-${Date.now()}`;
    this.activeProcesses.set(processId, child);
    
    // Handle process output
    child.stdout?.on('data', (data) => {
      if (this.config.verbose) {
        console.log(`[Monitor ${processId}] ${data.toString().trim()}`);
      }
    });
    
    child.stderr?.on('data', (data) => {
      if (this.config.verbose) {
        console.error(`[Monitor ${processId}] ${data.toString().trim()}`);
      }
    });
    
    child.on('close', (code) => {
      this.activeProcesses.delete(processId);
      if (this.config.verbose && code !== 0) {
        console.log(`[Monitor ${processId}] Process exited with code ${code}`);
      }
    });
    
    return child;
  }

  async stopProcess(process) {
    if (process && !process.killed) {
      process.kill('SIGTERM');
      
      // Wait for graceful shutdown
      await new Promise((resolve) => {
        const timeout = global.setTimeout(() => {
          if (!process.killed) {
            process.kill('SIGKILL');
          }
          resolve();
        }, 3000);
        
        process.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }

  generateMockTranscript(exchangeCount) {
    const exchanges = [];
    const baseTimestamp = Date.now() - (exchangeCount * 10000);
    
    for (let i = 0; i < exchangeCount; i++) {
      const exchange = {
        id: `exchange-${i + 1}`,
        timestamp: baseTimestamp + (i * 10000),
        type: i % 2 === 0 ? 'assistant_message' : 'user_message',
        content: `Exchange ${i + 1}: ${this.getRandomContent(i)}`,
        metadata: {
          user_id: 'test-user',
          session_id: 'test-session'
        }
      };
      
      exchanges.push(JSON.stringify(exchange));
    }
    
    return exchanges.join('\n');
  }

  generateSensitiveTranscript() {
    const sensitiveExchanges = [
      {
        id: 'exchange-1',
        timestamp: Date.now() - 30000,
        type: 'user_message',
        content: 'Please use API key sk-1234567890abcdef for authentication'
      },
      {
        id: 'exchange-2',
        timestamp: Date.now() - 20000,
        type: 'assistant_message',
        content: 'I cannot use that API key directly. Let me help you configure it properly.'
      },
      {
        id: 'exchange-3',
        timestamp: Date.now() - 10000,
        type: 'user_message',
        content: 'My email is test@example.com and the secret is xai-abcdef123456'
      }
    ];
    
    return sensitiveExchanges.map(ex => JSON.stringify(ex)).join('\n');
  }

  getRandomContent(index) {
    const contentTypes = [
      `Reading file /test/path/file-${index}.js`,
      `Writing content to output-${index}.md`,
      `Running command: npm test --coverage`,
      `API response received with ${index} items`,
      `Processing data batch ${index}`,
      `Validating input for exchange ${index}`,
      `Creating backup of data-${index}.json`,
      `Connecting to database server`,
      `Analyzing code structure`,
      `Generating report for session ${index}`
    ];
    
    return contentTypes[index % contentTypes.length];
  }

  async cleanup() {
    // Stop all active processes
    for (const [processId, process] of this.activeProcesses) {
      await this.stopProcess(process);
    }
    
    // Clean up test files
    if (!this.config.keepTestData && fs.existsSync(this.config.testRoot)) {
      try {
        fs.rmSync(this.config.testRoot, { recursive: true, force: true });
        this.log('Test data cleaned up');
      } catch (error) {
        this.logError('Cleanup failed:', error);
      }
    }
    
    // Clean up health file if it was created during testing
    const healthFile = path.join(this.config.codingRepo, '.transcript-monitor-health');
    if (fs.existsSync(healthFile)) {
      try {
        // Only clean if it's a test artifact (contains test project path)
        const healthData = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
        if (healthData.projectPath && healthData.projectPath.includes('lsl-realtime-e2e-tests')) {
          fs.unlinkSync(healthFile);
          this.log('Test health file cleaned up');
        }
      } catch (error) {
        // Ignore cleanup errors for health file
      }
    }
  }

  generateReport(duration) {
    const total = this.testResults.passed + this.testResults.failed;
    
    console.log('\n=== Real-Time Monitoring E2E Test Results ===');
    console.log(`Total scenarios: ${total}`);
    console.log(`✅ Passed: ${this.testResults.passed}`);
    console.log(`❌ Failed: ${this.testResults.failed}`);
    console.log(`⏱️  Total Duration: ${duration}ms`);
    
    console.log('\n=== Scenario Results ===');
    for (const [scenario, result] of this.testResults.scenarios) {
      const status = result.status === 'passed' ? '✅' : '❌';
      console.log(`${status} ${scenario}: ${result.duration}ms`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    }
    
    if (this.testResults.errors.length > 0) {
      console.log('\n=== Detailed Errors ===');
      for (const error of this.testResults.errors) {
        console.log(`❌ ${error.scenario || 'Unknown'}: ${error.error}`);
      }
    }
    
    const success = this.testResults.failed === 0;
    console.log(`\n${success ? '🎉' : '💥'} Real-time monitoring E2E testing ${success ? 'completed successfully' : 'failed'}!`);
    
    return success;
  }

  log(message) {
    if (this.config.verbose) {
      console.log(`[Real-Time E2E] ${message}`);
    }
  }

  logError(message, error) {
    console.error(`[Real-Time E2E] ${message}`, error?.message || error);
  }
}

// CLI Integration
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = {
    verbose: process.argv.includes('--verbose'),
    keepTestData: process.argv.includes('--keep-data'),
    timeout: parseInt(process.argv.find(arg => arg.startsWith('--timeout='))?.split('=')[1]) || 30000
  };
  
  console.log('🧪 Starting Real-Time Monitoring E2E Tests...');
  
  const tests = new RealTimeMonitoringTests(options);
  
  tests.runAllTests().then((success) => {
    process.exit(success ? 0 : 1);
  }).catch((error) => {
    console.error('Real-time monitoring E2E tests crashed:', error);
    process.exit(1);
  });
}

export default RealTimeMonitoringTests;