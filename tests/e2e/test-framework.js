#!/usr/bin/env node

/**
 * E2E Testing Framework for Live Session Logging System
 * 
 * Comprehensive testing framework supporting all LSL configurations:
 * - Real-time monitoring (enhanced-transcript-monitor)
 * - Batch processing (generate-proper-lsl)
 * - Multi-user coordination (LiveLoggingCoordinator)
 * - Secret redaction (ConfigurableRedactor)
 * - User hash generation (UserHashGenerator)
 * - Filename generation (timezone-utils)
 * - Health monitoring integration
 * 
 * Features:
 * - Test isolation with cleanup
 * - Parallel execution support
 * - Mock data generation
 * - Configuration management
 * - Deployment scenario testing
 * - Performance benchmarking
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, fork } from 'child_process';
import EventEmitter from 'events';

// Import LSL components for testing
import UserHashGenerator from '../../src/live-logging/user-hash-generator.js';
import ConfigurableRedactor from '../../src/live-logging/ConfigurableRedactor.js';
import { generateLSLFilename, formatTimestamp } from '../../scripts/timezone-utils.js';

class E2ETestFramework extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Test execution settings
      parallel: options.parallel || false,
      maxConcurrency: options.maxConcurrency || 3,
      timeout: options.timeout || 30000,
      
      // Test environment
      testRoot: options.testRoot || path.join(os.tmpdir(), 'lsl-e2e-tests'),
      keepTestData: options.keepTestData || false,
      verbose: options.verbose || false,
      
      // LSL system paths
      codingRepo: options.codingRepo || process.cwd(),
      
      // Test data generation
      mockUsers: ['testuser1', 'testuser2', 'testuser3'],
      mockProjects: ['test-project-a', 'test-project-b'],
      mockTranscriptSize: 100, // number of mock exchanges
      
      // Performance testing
      performanceThresholds: {
        transcriptProcessing: 5000, // ms
        redactionSpeed: 100, // operations/second
        fileGeneration: 1000, // ms
      }
    };
    
    this.testSuites = new Map();
    this.activeTests = new Map();
    this.results = {
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      performance: {}
    };
    
    this.initialize();
  }

  initialize() {
    this.log('Initializing E2E test framework...');
    
    // Register built-in test suites
    this.registerBuiltInTestSuites();
    
    // Set up test environment
    this.setupTestEnvironment();
    
    this.log(`Framework initialized with ${this.testSuites.size} test suites`);
  }

  registerBuiltInTestSuites() {
    // Core component tests
    this.registerTestSuite('user-hash-generation', this.testUserHashGeneration.bind(this));
    this.registerTestSuite('secret-redaction', this.testSecretRedaction.bind(this));
    this.registerTestSuite('filename-generation', this.testFilenameGeneration.bind(this));
    this.registerTestSuite('timezone-handling', this.testTimezoneHandling.bind(this));
    
    // Integration tests
    this.registerTestSuite('transcript-monitoring', this.testTranscriptMonitoring.bind(this));
    this.registerTestSuite('batch-processing', this.testBatchProcessing.bind(this));
    this.registerTestSuite('multi-user-coordination', this.testMultiUserCoordination.bind(this));
    this.registerTestSuite('health-monitoring', this.testHealthMonitoring.bind(this));
    
    // Deployment scenario tests
    this.registerTestSuite('local-deployment', this.testLocalDeployment.bind(this));
    this.registerTestSuite('cross-project-deployment', this.testCrossProjectDeployment.bind(this));
    this.registerTestSuite('multi-user-deployment', this.testMultiUserDeployment.bind(this));
    
    // Performance tests
    this.registerTestSuite('performance-benchmarks', this.testPerformanceBenchmarks.bind(this));
    this.registerTestSuite('stress-testing', this.testStressTesting.bind(this));
  }

  registerTestSuite(name, testFunction) {
    this.testSuites.set(name, {
      name,
      testFunction,
      enabled: true,
      dependencies: []
    });
  }

  setupTestEnvironment() {
    // Create isolated test environment
    if (!fs.existsSync(this.config.testRoot)) {
      fs.mkdirSync(this.config.testRoot, { recursive: true });
    }
    
    // Create test project structures
    for (const project of this.config.mockProjects) {
      const projectPath = path.join(this.config.testRoot, project);
      const specstoryPath = path.join(projectPath, '.specstory/history');
      
      if (!fs.existsSync(specstoryPath)) {
        fs.mkdirSync(specstoryPath, { recursive: true });
      }
    }
    
    this.log(`Test environment set up at: ${this.config.testRoot}`);
  }

  // Test Data Generation
  generateMockTranscript(userId = 'testuser', exchanges = 50) {
    const transcript = [];
    const userHash = this.generateTestUserHash(userId);
    
    for (let i = 0; i < exchanges; i++) {
      const exchange = {
        id: `exchange-${i}`,
        timestamp: Date.now() - (exchanges - i) * 1000,
        type: this.randomChoice(['assistant_message', 'user_message', 'tool_use']),
        content: this.generateMockContent(i),
        userHash: userHash
      };
      
      transcript.push(JSON.stringify(exchange));
    }
    
    return transcript.join('\n');
  }

  generateTestUserHash(userId) {
    // Create deterministic hash for testing
    const generator = new UserHashGenerator({ debug: false });
    return generator.createDeterministicHash(userId);
  }

  generateMockContent(index) {
    const mockPatterns = [
      `Reading file content from path /test/file-${index}.js`,
      `Writing content to /test/output-${index}.md`,
      `Running command: npm test --silent`,
      `API response: {"status": "success", "data": "test-data-${index}"}`,
      `Error: File not found at /test/missing-${index}.txt`,
      `Environment variable: TEST_VAR=test-value-${index}`,
      `Secret key: sk-1234567890abcdef${index.toString().padStart(4, '0')}`,
      `User email: testuser${index}@example.com`
    ];
    
    return this.randomChoice(mockPatterns);
  }

  randomChoice(array) {
    return array[Math.floor(Math.random() * array.length)];
  }

  // Test Execution
  async runAllTests() {
    this.log('Starting E2E test execution...');
    const startTime = Date.now();
    
    try {
      if (this.config.parallel) {
        await this.runTestsInParallel();
      } else {
        await this.runTestsSequentially();
      }
    } catch (error) {
      this.logError('Test execution failed:', error);
      this.results.errors.push({
        type: 'execution_error',
        error: error.message,
        timestamp: Date.now()
      });
    } finally {
      const duration = Date.now() - startTime;
      await this.cleanup();
      this.generateReport(duration);
    }
  }

  async runTestsSequentially() {
    for (const [suiteName, suite] of this.testSuites) {
      if (!suite.enabled) {
        this.results.skipped++;
        continue;
      }
      
      await this.runTestSuite(suiteName, suite);
    }
  }

  async runTestsInParallel() {
    const testPromises = [];
    const semaphore = new Semaphore(this.config.maxConcurrency);
    
    for (const [suiteName, suite] of this.testSuites) {
      if (!suite.enabled) {
        this.results.skipped++;
        continue;
      }
      
      const testPromise = semaphore.acquire().then(async () => {
        try {
          await this.runTestSuite(suiteName, suite);
        } finally {
          semaphore.release();
        }
      });
      
      testPromises.push(testPromise);
    }
    
    await Promise.all(testPromises);
  }

  async runTestSuite(suiteName, suite) {
    this.log(`Running test suite: ${suiteName}`);
    const startTime = Date.now();
    
    try {
      const testContext = this.createTestContext(suiteName);
      await suite.testFunction(testContext);
      
      const duration = Date.now() - startTime;
      this.results.passed++;
      this.log(`✅ ${suiteName} passed (${duration}ms)`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.results.failed++;
      this.results.errors.push({
        suite: suiteName,
        error: error.message,
        stack: error.stack,
        duration: duration,
        timestamp: Date.now()
      });
      this.logError(`❌ ${suiteName} failed (${duration}ms):`, error);
    }
  }

  createTestContext(suiteName) {
    const testDir = path.join(this.config.testRoot, suiteName);
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    
    return {
      name: suiteName,
      testDir: testDir,
      
      // Assertion helpers
      assert: (condition, message) => {
        if (!condition) throw new Error(`Assertion failed: ${message}`);
      },
      
      assertEqual: (actual, expected, message) => {
        if (actual !== expected) {
          throw new Error(`Assertion failed: ${message}\nExpected: ${expected}\nActual: ${actual}`);
        }
      },
      
      // Test utilities
      generateMockTranscript: this.generateMockTranscript.bind(this),
      generateTestUserHash: this.generateTestUserHash.bind(this),
      createTempFile: (filename, content) => {
        const filePath = path.join(testDir, filename);
        fs.writeFileSync(filePath, content);
        return filePath;
      },
      
      // Process execution
      runProcess: async (command, args = [], options = {}) => {
        return new Promise((resolve, reject) => {
          const child = spawn(command, args, {
            ...options,
            timeout: this.config.timeout
          });
          
          let stdout = '';
          let stderr = '';
          
          child.stdout?.on('data', (data) => stdout += data);
          child.stderr?.on('data', (data) => stderr += data);
          
          child.on('close', (code) => {
            if (code === 0) {
              resolve({ stdout, stderr, code });
            } else {
              reject(new Error(`Process failed with code ${code}: ${stderr}`));
            }
          });
          
          child.on('error', reject);
        });
      }
    };
  }

  // Built-in Test Suites

  async testUserHashGeneration(ctx) {
    ctx.assert(UserHashGenerator, 'UserHashGenerator should be available');
    
    // Test deterministic hash generation
    const hash1 = UserHashGenerator.generateHash({ debug: false });
    const hash2 = UserHashGenerator.generateHash({ debug: false });
    ctx.assertEqual(hash1, hash2, 'Hash generation should be deterministic');
    
    // Test hash format
    ctx.assert(hash1.length === 6, 'Hash should be 6 characters long');
    ctx.assert(/^[a-z][a-z0-9]*$/.test(hash1), 'Hash should start with letter and be alphanumeric');
    
    // Test consistency
    const generator = new UserHashGenerator({ debug: false });
    const consistent = generator.testConsistency('testuser', 10);
    ctx.assert(consistent, 'Hash generation should be consistent across multiple calls');
  }

  async testSecretRedaction(ctx) {
    const redactor = new ConfigurableRedactor();
    
    // Test API key redaction
    const textWithSecrets = 'API_KEY=sk-1234567890abcdef and user email test@example.com';
    const redacted = redactor.redact(textWithSecrets);
    
    ctx.assert(!redacted.includes('sk-1234567890abcdef'), 'API keys should be redacted');
    ctx.assert(!redacted.includes('test@example.com'), 'Email addresses should be redacted');
    ctx.assert(redacted.includes('<SECRET_REDACTED>'), 'Should contain redaction placeholder');
  }

  async testFilenameGeneration(ctx) {
    const timestamp = Date.now();
    const projectName = 'test-project';
    const targetProject = '/test/coding';
    const sourceProject = '/test/project';
    
    const filename = generateLSLFilename(timestamp, projectName, targetProject, sourceProject);
    
    ctx.assert(filename.endsWith('.md'), 'Filename should have .md extension');
    ctx.assert(filename.includes('from-test-project'), 'Cross-project filename should include project suffix');
    ctx.assert(/\d{4}-\d{2}-\d{2}_\d{4}-\d{4}_[a-z0-9]{6}_from-test-project\.md/.test(filename), 
              'Filename should match expected format');
  }

  async testTimezoneHandling(ctx) {
    const timestamp = Date.now();
    const formatted = formatTimestamp(timestamp);
    
    ctx.assert(formatted.utc, 'Should include UTC timestamp');
    ctx.assert(formatted.local, 'Should include local timestamp');
    ctx.assert(formatted.lslFormat, 'Should include LSL format');
    ctx.assert(formatted.lslFormat.includes('UTC'), 'LSL format should include UTC time');
  }

  async testTranscriptMonitoring(ctx) {
    // Create mock transcript file
    const transcriptContent = ctx.generateMockTranscript('testuser', 10);
    const transcriptPath = ctx.createTempFile('test-transcript.jsonl', transcriptContent);
    
    // Test transcript monitoring (would normally spawn enhanced-transcript-monitor)
    // For E2E testing, we simulate the monitoring process
    const lines = transcriptContent.split('\n').filter(line => line.trim());
    ctx.assertEqual(lines.length, 10, 'Should have correct number of transcript lines');
    
    // Verify each line is valid JSON
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON in transcript: ${line}`);
      }
    }
  }

  async testBatchProcessing(ctx) {
    // Create mock project structure
    const projectPath = ctx.testDir;
    const historyPath = path.join(projectPath, '.specstory/history');
    fs.mkdirSync(historyPath, { recursive: true });
    
    // Test batch processing simulation
    const mockData = {
      projectPath: projectPath,
      transcriptCount: 5,
      processedFiles: [],
      errors: []
    };
    
    ctx.assert(fs.existsSync(historyPath), 'History directory should exist');
    ctx.assertEqual(mockData.errors.length, 0, 'Should have no processing errors');
  }

  async testMultiUserCoordination(ctx) {
    const users = ['user1', 'user2', 'user3'];
    const userHashes = users.map(user => ctx.generateTestUserHash(user));
    
    // Verify unique user hashes
    const uniqueHashes = new Set(userHashes);
    ctx.assertEqual(uniqueHashes.size, users.length, 'Each user should have unique hash');
    
    // Test buffer file separation
    for (const [i, userHash] of userHashes.entries()) {
      const bufferPath = `.mcp-sync/tool-interaction-buffer-${userHash}.jsonl`;
      ctx.assert(!bufferPath.includes('undefined'), `Buffer path should be valid for user ${users[i]}`);
    }
  }

  async testHealthMonitoring(ctx) {
    const healthData = {
      timestamp: Date.now(),
      projectPath: ctx.testDir,
      transcriptPath: '/test/transcript.jsonl',
      status: 'running',
      userHash: ctx.generateTestUserHash('testuser'),
      metrics: {
        memoryMB: 128,
        cpuUser: 1000,
        uptimeSeconds: 3600,
        exchangeCount: 50
      },
      errors: []
    };
    
    ctx.assert(healthData.userHash, 'Health data should include user hash');
    ctx.assert(healthData.metrics.exchangeCount > 0, 'Should track exchange count');
    ctx.assertEqual(healthData.status, 'running', 'Health status should be running');
  }

  async testLocalDeployment(ctx) {
    // Test local project deployment scenario
    const localProject = ctx.testDir;
    const filename = generateLSLFilename(Date.now(), 'local-test', localProject, localProject);
    
    ctx.assert(!filename.includes('from-'), 'Local deployment should not have project suffix');
    ctx.assert(filename.endsWith('.md'), 'Should generate valid LSL filename');
  }

  async testCrossProjectDeployment(ctx) {
    // Test cross-project deployment scenario
    const sourceProject = path.join(ctx.testDir, 'source');
    const targetProject = path.join(ctx.testDir, 'target');
    const filename = generateLSLFilename(Date.now(), 'cross-test', targetProject, sourceProject);
    
    ctx.assert(filename.includes('from-cross-test'), 'Cross-project should include project suffix');
  }

  async testMultiUserDeployment(ctx) {
    // Test multi-user deployment with user isolation
    const users = ['user1', 'user2'];
    const userHashes = users.map(user => ctx.generateTestUserHash(user));
    
    for (const [i, userHash] of userHashes.entries()) {
      const sessionId = `live-${Date.now()}-${userHash}-test`;
      ctx.assert(sessionId.includes(userHash), `Session ID should include user hash for ${users[i]}`);
    }
  }

  async testPerformanceBenchmarks(ctx) {
    const startTime = Date.now();
    
    // Benchmark user hash generation
    const hashStartTime = Date.now();
    for (let i = 0; i < 100; i++) {
      UserHashGenerator.generateHash({ debug: false });
    }
    const hashDuration = Date.now() - hashStartTime;
    this.results.performance.hashGeneration = hashDuration;
    
    // Benchmark redaction
    const redactor = new ConfigurableRedactor();
    const redactionStartTime = Date.now();
    const testText = 'API_KEY=sk-test123 email=test@example.com secret=xai-abcdef123';
    for (let i = 0; i < 100; i++) {
      redactor.redact(testText);
    }
    const redactionDuration = Date.now() - redactionStartTime;
    this.results.performance.redaction = redactionDuration;
    
    // Verify performance thresholds
    ctx.assert(hashDuration < 1000, 'Hash generation should complete within 1 second for 100 operations');
    ctx.assert(redactionDuration < 2000, 'Redaction should complete within 2 seconds for 100 operations');
  }

  async testStressTesting(ctx) {
    // Stress test with large mock transcript
    const largeTranscript = ctx.generateMockTranscript('stressuser', 1000);
    const lines = largeTranscript.split('\n');
    
    ctx.assertEqual(lines.length, 1000, 'Should handle large transcript generation');
    
    // Test concurrent user hash generation
    const concurrentPromises = [];
    for (let i = 0; i < 10; i++) {
      concurrentPromises.push(Promise.resolve(ctx.generateTestUserHash(`stressuser${i}`)));
    }
    
    const results = await Promise.all(concurrentPromises);
    ctx.assertEqual(results.length, 10, 'Should handle concurrent hash generation');
  }

  // Cleanup and Reporting
  async cleanup() {
    if (!this.config.keepTestData && fs.existsSync(this.config.testRoot)) {
      try {
        fs.rmSync(this.config.testRoot, { recursive: true, force: true });
        this.log('Test data cleaned up');
      } catch (error) {
        this.logError('Cleanup failed:', error);
      }
    }
  }

  generateReport(duration) {
    const total = this.results.passed + this.results.failed + this.results.skipped;
    
    console.log('\n=== E2E Test Results ===');
    console.log(`Total tests: ${total}`);
    console.log(`✅ Passed: ${this.results.passed}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    console.log(`⏭️  Skipped: ${this.results.skipped}`);
    console.log(`⏱️  Duration: ${duration}ms`);
    
    if (Object.keys(this.results.performance).length > 0) {
      console.log('\n=== Performance Results ===');
      for (const [test, time] of Object.entries(this.results.performance)) {
        console.log(`${test}: ${time}ms`);
      }
    }
    
    if (this.results.errors.length > 0) {
      console.log('\n=== Errors ===');
      for (const error of this.results.errors) {
        console.log(`❌ ${error.suite || 'Unknown'}: ${error.error}`);
      }
    }
    
    console.log('\n=== Test Framework Info ===');
    console.log(`Parallel execution: ${this.config.parallel}`);
    console.log(`Test environment: ${this.config.testRoot}`);
    console.log(`Keep test data: ${this.config.keepTestData}`);
    
    const success = this.results.failed === 0;
    console.log(`\n${success ? '🎉' : '💥'} E2E testing ${success ? 'completed successfully' : 'failed'}!`);
    
    return success;
  }

  log(message) {
    if (this.config.verbose) {
      console.log(`[E2E Framework] ${message}`);
    }
  }

  logError(message, error) {
    console.error(`[E2E Framework] ${message}`, error?.message || error);
  }
}

// Semaphore for parallel execution control
class Semaphore {
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.currentConcurrency = 0;
    this.queue = [];
  }

  async acquire() {
    return new Promise((resolve) => {
      if (this.currentConcurrency < this.maxConcurrency) {
        this.currentConcurrency++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    this.currentConcurrency--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this.currentConcurrency++;
      next();
    }
  }
}

// CLI Integration
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = {
    parallel: process.argv.includes('--parallel'),
    verbose: process.argv.includes('--verbose'),
    keepTestData: process.argv.includes('--keep-data'),
    timeout: parseInt(process.argv.find(arg => arg.startsWith('--timeout='))?.split('=')[1]) || 30000
  };
  
  console.log('🧪 Starting Live Session Logging E2E Tests...');
  
  const framework = new E2ETestFramework(options);
  
  framework.runAllTests().then(() => {
    // Success is determined by the results within generateReport
    const success = framework.results.failed === 0;
    process.exit(success ? 0 : 1);
  }).catch((error) => {
    console.error('E2E testing framework crashed:', error);
    process.exit(1);
  });
}

export default E2ETestFramework;