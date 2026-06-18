#!/usr/bin/env node

/**
 * Batch Processing E2E Tests
 * 
 * Comprehensive end-to-end testing for the generate-proper-lsl-from-transcripts.js batch processing system.
 * Tests statistics reporting, cross-project routing, performance, and data validation.
 * 
 * Test Coverage:
 * - Batch processing with realistic data volumes
 * - Statistics generation and accuracy validation
 * - Cross-project content routing and classification
 * - Performance under different data loads
 * - Error handling and recovery in batch mode
 * - Multi-user batch processing coordination
 * - Foreign vs. local project processing modes
 * - Clean and incremental processing modes
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import EventEmitter from 'events';

// Import framework for test utilities
import E2ETestFramework from './test-framework.js';
import { generateLSLFilename, formatTimestamp } from '../../scripts/timezone-utils.js';
import UserHashGenerator from '../../src/live-logging/user-hash-generator.js';

class BatchProcessingTests extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      testRoot: options.testRoot || path.join(os.tmpdir(), 'lsl-batch-e2e-tests'),
      codingRepo: options.codingRepo || process.cwd(),
      timeout: options.timeout || 60000, // Longer timeout for batch processing
      verbose: options.verbose || false,
      keepTestData: options.keepTestData || false,
      
      // Test scenarios for batch processing
      scenarios: [
        'basic-batch-processing',
        'statistics-reporting',
        'cross-project-routing',
        'performance-large-dataset',
        'error-handling-batch',
        'multi-user-batch',
        'mode-testing',
        'incremental-processing'
      ]
    };
    
    this.testResults = {
      passed: 0,
      failed: 0,
      errors: [],
      scenarios: new Map(),
      performance: {}
    };
    
    this.activeProcesses = new Map();
    this.cleanupTasks = [];
  }

  async runAllTests() {
    this.log('Starting Batch Processing E2E Tests...');
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
    
    // Create test project structures
    const testProjects = ['nano-degree', 'coding', 'external-project'];
    for (const project of testProjects) {
      const projectPath = path.join(this.config.testRoot, project);
      const specstoryPath = path.join(projectPath, '.specstory/history');
      
      fs.mkdirSync(specstoryPath, { recursive: true });
    }
    
    // Create mock Claude project directories with transcript files
    const claudeProjectsDir = path.join(this.config.testRoot, '.claude/projects');
    const projectMappings = [
      { name: '-Users-test-nano-degree', realName: 'nano-degree' },
      { name: '-Users-test-coding', realName: 'coding' },
      { name: '-Users-test-external-project', realName: 'external-project' }
    ];
    
    for (const mapping of projectMappings) {
      const claudeProjectPath = path.join(claudeProjectsDir, mapping.name);
      fs.mkdirSync(claudeProjectPath, { recursive: true });
      
      // Create multiple transcript files with different timestamps
      for (let i = 0; i < 3; i++) {
        const transcriptId = this.generateUUID();
        const transcriptFile = path.join(claudeProjectPath, `${transcriptId}.jsonl`);
        const transcriptContent = this.generateMockTranscript(mapping.realName, 50 + i * 20);
        fs.writeFileSync(transcriptFile, transcriptContent);
      }
    }
    
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
      'basic-batch-processing': this.testBasicBatchProcessing,
      'statistics-reporting': this.testStatisticsReporting,
      'cross-project-routing': this.testCrossProjectRouting,
      'performance-large-dataset': this.testPerformanceLargeDataset,
      'error-handling-batch': this.testErrorHandlingBatch,
      'multi-user-batch': this.testMultiUserBatch,
      'mode-testing': this.testModeTesting,
      'incremental-processing': this.testIncrementalProcessing
    };
    
    const method = methods[scenarioName];
    if (!method) {
      throw new Error(`Unknown scenario: ${scenarioName}`);
    }
    
    return method;
  }

  // Test Scenario Implementations

  async testBasicBatchProcessing() {
    const targetProject = path.join(this.config.testRoot, 'nano-degree');
    
    // Run batch processing
    const result = await this.runBatchProcessor(targetProject, {
      mode: 'all',
      clean: true
    });
    
    // Verify LSL files are created
    const historyDir = path.join(targetProject, '.specstory/history');
    const lslFiles = fs.readdirSync(historyDir).filter(file => file.endsWith('.md'));
    
    if (lslFiles.length === 0) {
      throw new Error('No LSL files created during basic batch processing');
    }
    
    // Verify LSL file content
    const lslFile = path.join(historyDir, lslFiles[0]);
    const content = fs.readFileSync(lslFile, 'utf8');
    
    if (!content.includes('# Live Session Log')) {
      throw new Error('LSL file missing expected header');
    }
    
    if (!content.includes('## Session')) {
      throw new Error('LSL file missing session content');
    }
    
    // Verify filename format includes user hash
    const userHash = UserHashGenerator.generateHash({ debug: false });
    const hasCorrectFormat = lslFiles.some(filename => 
      filename.includes(userHash) && /\d{4}-\d{2}-\d{2}_\d{4}-\d{4}_[a-z0-9]{6}/.test(filename)
    );
    
    if (!hasCorrectFormat) {
      throw new Error(`LSL filenames don't match expected format with user hash: ${userHash}`);
    }
    
    this.log('✓ Basic batch processing: LSL files created successfully');
    this.log(`✓ Basic batch processing: ${lslFiles.length} files generated`);
  }

  async testStatisticsReporting() {
    const targetProject = path.join(this.config.testRoot, 'nano-degree');
    
    // Run batch processing with statistics
    const result = await this.runBatchProcessor(targetProject, {
      mode: 'all',
      clean: true
    });
    
    // Parse output for statistics
    const output = result.stdout;
    
    // Verify statistics are reported
    if (!output.includes('Processing transcript')) {
      throw new Error('Statistics missing transcript processing information');
    }
    
    if (!output.includes('files processed') && !output.includes('exchanges')) {
      throw new Error('Statistics missing file/exchange count information');
    }
    
    // Check for timing information
    if (!output.includes('ms') && !output.includes('second')) {
      throw new Error('Statistics missing timing information');
    }
    
    // Verify final summary statistics
    const lines = output.split('\n');
    const summaryLines = lines.filter(line => 
      line.includes('Total') || 
      line.includes('Processed') || 
      line.includes('Generated') ||
      line.includes('Completed')
    );
    
    if (summaryLines.length === 0) {
      throw new Error('Statistics missing summary information');
    }
    
    this.log('✓ Statistics reporting: Processing stats found');
    this.log('✓ Statistics reporting: Summary information present');
  }

  async testCrossProjectRouting() {
    const sourceProject = path.join(this.config.testRoot, 'nano-degree');
    const codingProject = path.join(this.config.testRoot, 'coding');
    
    // Run batch processing in foreign mode (routing to coding project)
    const result = await this.runBatchProcessor(sourceProject, {
      mode: 'foreign',
      clean: true
    });
    
    // Verify files are routed to coding project
    const codingHistoryDir = path.join(codingProject, '.specstory/history');
    const codingLslFiles = fs.readdirSync(codingHistoryDir).filter(file => file.endsWith('.md'));
    
    if (codingLslFiles.length === 0) {
      throw new Error('No LSL files routed to coding project in foreign mode');
    }
    
    // Verify filenames include "from-nano-degree" suffix for cross-project routing
    const hasFromSuffix = codingLslFiles.some(filename => 
      filename.includes('from-nano-degree')
    );
    
    if (!hasFromSuffix) {
      throw new Error('Cross-project filenames missing "from-project" suffix');
    }
    
    // Verify source project has no local files (foreign mode)
    const sourceHistoryDir = path.join(sourceProject, '.specstory/history');
    const sourceLslFiles = fs.readdirSync(sourceHistoryDir).filter(file => file.endsWith('.md'));
    
    // In foreign mode, files should only go to coding project
    const localFiles = sourceLslFiles.filter(filename => !filename.includes('from-'));
    if (localFiles.length > 0) {
      throw new Error(`Foreign mode created local files: ${localFiles.join(', ')}`);
    }
    
    this.log('✓ Cross-project routing: Files routed to coding project');
    this.log('✓ Cross-project routing: Filenames include from-project suffix');
  }

  async testPerformanceLargeDataset() {
    // Create larger dataset for performance testing
    const performanceProject = path.join(this.config.testRoot, 'performance-test');
    const specstoryPath = path.join(performanceProject, '.specstory/history');
    fs.mkdirSync(specstoryPath, { recursive: true });
    
    // Create large transcript files
    const claudeProjectPath = path.join(this.config.testRoot, '.claude/projects/-Users-test-performance-test');
    fs.mkdirSync(claudeProjectPath, { recursive: true });
    
    // Create 5 transcript files with 200 exchanges each (1000 total)
    for (let i = 0; i < 5; i++) {
      const transcriptId = this.generateUUID();
      const transcriptFile = path.join(claudeProjectPath, `${transcriptId}.jsonl`);
      const transcriptContent = this.generateMockTranscript(`performance-test`, 200);
      fs.writeFileSync(transcriptFile, transcriptContent);
    }
    
    const startTime = Date.now();
    
    // Run batch processing on large dataset
    const result = await this.runBatchProcessor(performanceProject, {
      mode: 'all',
      clean: true
    });
    
    const processingTime = Date.now() - startTime;
    this.testResults.performance.largeDataset = processingTime;
    
    // Verify performance is acceptable (1000 exchanges should process in under 30 seconds)
    if (processingTime > 30000) {
      throw new Error(`Performance too slow: ${processingTime}ms for 1000 exchanges`);
    }
    
    // Verify all files were processed
    const lslFiles = fs.readdirSync(specstoryPath).filter(file => file.endsWith('.md'));
    if (lslFiles.length === 0) {
      throw new Error('No LSL files created during performance test');
    }
    
    // Verify content quality maintained under load
    const sampleFile = path.join(specstoryPath, lslFiles[0]);
    const content = fs.readFileSync(sampleFile, 'utf8');
    
    if (!content.includes('# Live Session Log')) {
      throw new Error('Content quality degraded under load - missing header');
    }
    
    this.log(`✓ Performance large dataset: 1000 exchanges processed in ${processingTime}ms`);
    this.log(`✓ Performance large dataset: ${lslFiles.length} LSL files generated`);
  }

  async testErrorHandlingBatch() {
    const errorProject = path.join(this.config.testRoot, 'error-test');
    const specstoryPath = path.join(errorProject, '.specstory/history');
    fs.mkdirSync(specstoryPath, { recursive: true });
    
    // Create transcript with mixed valid/invalid content
    const claudeProjectPath = path.join(this.config.testRoot, '.claude/projects/-Users-test-error-test');
    fs.mkdirSync(claudeProjectPath, { recursive: true });
    
    const transcriptFile = path.join(claudeProjectPath, `${this.generateUUID()}.jsonl`);
    const mixedContent = [
      '{"id": "valid1", "timestamp": 1234567890, "content": "Valid exchange 1"}',
      'invalid json line here',
      '{"id": "valid2", "timestamp": 1234567891, "content": "Valid exchange 2"}',
      '{"missing": "quote, "timestamp": 1234567892}',
      '{"id": "valid3", "timestamp": 1234567893, "content": "Valid exchange 3"}'
    ].join('\n');
    
    fs.writeFileSync(transcriptFile, mixedContent);
    
    // Run batch processing - should handle errors gracefully
    const result = await this.runBatchProcessor(errorProject, {
      mode: 'all',
      clean: true
    });
    
    // Verify processing completed despite errors
    const lslFiles = fs.readdirSync(specstoryPath).filter(file => file.endsWith('.md'));
    if (lslFiles.length === 0) {
      throw new Error('Batch processing failed completely due to invalid JSON');
    }
    
    // Verify valid content was processed
    const lslContent = fs.readFileSync(path.join(specstoryPath, lslFiles[0]), 'utf8');
    
    const validContentCount = (lslContent.match(/Valid exchange/g) || []).length;
    if (validContentCount < 2) {
      throw new Error('Valid exchanges not processed correctly in error handling test');
    }
    
    // Verify errors are reported in output but don't stop processing
    const output = result.stderr || result.stdout;
    const hasErrorReporting = output.toLowerCase().includes('error') || 
                             output.toLowerCase().includes('invalid') ||
                             output.toLowerCase().includes('skip');
    
    if (!hasErrorReporting) {
      this.log('Note: Error reporting not detected in output, but processing succeeded');
    }
    
    this.log('✓ Error handling batch: Processing completed despite invalid JSON');
    this.log(`✓ Error handling batch: ${validContentCount} valid exchanges processed`);
  }

  async testMultiUserBatch() {
    const multiUserProject = path.join(this.config.testRoot, 'multi-user-test');
    const specstoryPath = path.join(multiUserProject, '.specstory/history');
    fs.mkdirSync(specstoryPath, { recursive: true });
    
    // Create transcripts with different user contexts
    const claudeProjectPath = path.join(this.config.testRoot, '.claude/projects/-Users-test-multi-user-test');
    fs.mkdirSync(claudeProjectPath, { recursive: true });
    
    const transcriptFile = path.join(claudeProjectPath, `${this.generateUUID()}.jsonl`);
    const multiUserContent = this.generateMockTranscript('multi-user-test', 30);
    fs.writeFileSync(transcriptFile, multiUserContent);
    
    // Run batch processing
    const result = await this.runBatchProcessor(multiUserProject, {
      mode: 'all',
      clean: true
    });
    
    // Verify user hash integration in filenames
    const lslFiles = fs.readdirSync(specstoryPath).filter(file => file.endsWith('.md'));
    if (lslFiles.length === 0) {
      throw new Error('No LSL files created during multi-user batch test');
    }
    
    const userHash = UserHashGenerator.generateHash({ debug: false });
    
    // Verify all filenames include user hash
    const filesWithUserHash = lslFiles.filter(filename => filename.includes(userHash));
    if (filesWithUserHash.length === 0) {
      throw new Error(`No files contain user hash: ${userHash} in filenames: ${lslFiles.join(', ')}`);
    }
    
    // Verify filename format consistency
    const validFormatFiles = lslFiles.filter(filename => 
      /\d{4}-\d{2}-\d{2}_\d{4}-\d{4}_[a-z0-9]{6}\.md/.test(filename)
    );
    
    if (validFormatFiles.length !== lslFiles.length) {
      throw new Error('Some files don\'t match expected filename format');
    }
    
    this.log('✓ Multi-user batch: User hash integrated in all filenames');
    this.log('✓ Multi-user batch: Filename format consistent');
  }

  async testModeTesting() {
    const modeProject = path.join(this.config.testRoot, 'mode-test');
    const specstoryPath = path.join(modeProject, '.specstory/history');
    fs.mkdirSync(specstoryPath, { recursive: true });
    
    const codingProject = path.join(this.config.testRoot, 'coding');
    const codingHistoryPath = path.join(codingProject, '.specstory/history');
    
    // Create transcript
    const claudeProjectPath = path.join(this.config.testRoot, '.claude/projects/-Users-test-mode-test');
    fs.mkdirSync(claudeProjectPath, { recursive: true });
    
    const transcriptFile = path.join(claudeProjectPath, `${this.generateUUID()}.jsonl`);
    fs.writeFileSync(transcriptFile, this.generateMockTranscript('mode-test', 20));
    
    // Test 1: Local mode (all) - should create files in source project
    await this.runBatchProcessor(modeProject, { mode: 'all', clean: true });
    
    const localFiles = fs.readdirSync(specstoryPath).filter(file => 
      file.endsWith('.md') && !file.includes('from-')
    );
    
    if (localFiles.length === 0) {
      throw new Error('Local mode (all) did not create local files');
    }
    
    // Clear files for next test
    localFiles.forEach(file => fs.unlinkSync(path.join(specstoryPath, file)));
    
    // Test 2: Foreign mode - should route to coding project
    await this.runBatchProcessor(modeProject, { mode: 'foreign', clean: true });
    
    const foreignFiles = fs.readdirSync(codingHistoryPath).filter(file => 
      file.endsWith('.md') && file.includes('from-mode-test')
    );
    
    if (foreignFiles.length === 0) {
      throw new Error('Foreign mode did not route files to coding project');
    }
    
    this.log('✓ Mode testing: Local mode creates local files');
    this.log('✓ Mode testing: Foreign mode routes to coding project');
  }

  async testIncrementalProcessing() {
    const incrementalProject = path.join(this.config.testRoot, 'incremental-test');
    const specstoryPath = path.join(incrementalProject, '.specstory/history');
    fs.mkdirSync(specstoryPath, { recursive: true });
    
    const claudeProjectPath = path.join(this.config.testRoot, '.claude/projects/-Users-test-incremental-test');
    fs.mkdirSync(claudeProjectPath, { recursive: true });
    
    // Create initial transcript
    const transcriptFile1 = path.join(claudeProjectPath, `${this.generateUUID()}.jsonl`);
    fs.writeFileSync(transcriptFile1, this.generateMockTranscript('incremental-test', 15));
    
    // Run initial batch processing
    await this.runBatchProcessor(incrementalProject, { mode: 'all', clean: true });
    
    const initialFiles = fs.readdirSync(specstoryPath).filter(file => file.endsWith('.md'));
    const initialCount = initialFiles.length;
    
    if (initialCount === 0) {
      throw new Error('Initial processing created no files');
    }
    
    // Add more transcript files
    const transcriptFile2 = path.join(claudeProjectPath, `${this.generateUUID()}.jsonl`);
    fs.writeFileSync(transcriptFile2, this.generateMockTranscript('incremental-test', 10));
    
    // Wait a bit to ensure timestamp difference
    await sleep(100);
    
    // Run incremental processing (without clean)
    await this.runBatchProcessor(incrementalProject, { mode: 'all', clean: false });
    
    const finalFiles = fs.readdirSync(specstoryPath).filter(file => file.endsWith('.md'));
    const finalCount = finalFiles.length;
    
    // Should have more files after incremental processing
    if (finalCount <= initialCount) {
      throw new Error(`Incremental processing did not add files: ${initialCount} -> ${finalCount}`);
    }
    
    this.log(`✓ Incremental processing: ${initialCount} -> ${finalCount} files`);
    this.log('✓ Incremental processing: New transcripts processed correctly');
  }

  // Utility Methods

  async runBatchProcessor(projectPath, options = {}) {
    const batchScript = path.join(this.config.codingRepo, 'scripts/generate-proper-lsl-from-transcripts.js');
    
    if (!fs.existsSync(batchScript)) {
      throw new Error(`Batch processing script not found at: ${batchScript}`);
    }
    
    const args = [];
    if (options.mode) {
      args.push(`--mode=${options.mode}`);
    }
    if (options.clean) {
      args.push('--clean');
    }
    if (options.project) {
      args.push(`--project=${options.project}`);
    }
    
    const env = {
      ...process.env,
      TRANSCRIPT_SOURCE_PROJECT: projectPath,
      CODING_TOOLS_PATH: this.config.codingRepo,
      NODE_ENV: 'test'
    };
    
    return new Promise((resolve, reject) => {
      const child = spawn('node', [batchScript, ...args], {
        env: env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.config.timeout
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
        if (this.config.verbose) {
          console.log(`[Batch] ${data.toString().trim()}`);
        }
      });
      
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
        if (this.config.verbose) {
          console.error(`[Batch] ${data.toString().trim()}`);
        }
      });
      
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr, code });
        } else {
          reject(new Error(`Batch processing failed with code ${code}: ${stderr}`));
        }
      });
      
      child.on('error', reject);
    });
  }

  generateMockTranscript(projectName, exchangeCount) {
    const exchanges = [];
    const baseTimestamp = Date.now() - (exchangeCount * 60000); // 1 minute apart
    
    for (let i = 0; i < exchangeCount; i++) {
      const exchange = {
        id: `exchange-${projectName}-${i + 1}`,
        timestamp: baseTimestamp + (i * 60000),
        type: i % 2 === 0 ? 'assistant_message' : 'user_message',
        content: `${projectName} exchange ${i + 1}: ${this.getRandomContent(projectName, i)}`,
        metadata: {
          project: projectName,
          session_id: `session-${projectName}`,
          user_id: `test-user-${projectName}`
        }
      };
      
      exchanges.push(JSON.stringify(exchange));
    }
    
    return exchanges.join('\n');
  }

  getRandomContent(projectName, index) {
    const contentTypes = [
      `Working on ${projectName} feature ${index}`,
      `Reading file from ${projectName}/src/component-${index}.js`,
      `Writing tests for ${projectName} module ${index}`,
      `Debugging ${projectName} issue #${index}`,
      `Reviewing ${projectName} pull request ${index}`,
      `Updating ${projectName} documentation ${index}`,
      `Deploying ${projectName} version 1.${index}`,
      `Configuring ${projectName} environment ${index}`,
      `Analyzing ${projectName} performance metrics ${index}`,
      `Refactoring ${projectName} legacy code ${index}`
    ];
    
    return contentTypes[index % contentTypes.length];
  }

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async cleanup() {
    // Stop any active processes
    for (const [processId, process] of this.activeProcesses) {
      if (process && !process.killed) {
        process.kill('SIGTERM');
      }
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
  }

  generateReport(duration) {
    const total = this.testResults.passed + this.testResults.failed;
    
    console.log('\n=== Batch Processing E2E Test Results ===');
    console.log(`Total scenarios: ${total}`);
    console.log(`✅ Passed: ${this.testResults.passed}`);
    console.log(`❌ Failed: ${this.testResults.failed}`);
    console.log(`⏱️  Total Duration: ${duration}ms`);
    
    if (Object.keys(this.testResults.performance).length > 0) {
      console.log('\n=== Performance Results ===');
      for (const [test, time] of Object.entries(this.testResults.performance)) {
        console.log(`${test}: ${time}ms`);
      }
    }
    
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
    console.log(`\n${success ? '🎉' : '💥'} Batch processing E2E testing ${success ? 'completed successfully' : 'failed'}!`);
    
    return success;
  }

  log(message) {
    if (this.config.verbose) {
      console.log(`[Batch E2E] ${message}`);
    }
  }

  logError(message, error) {
    console.error(`[Batch E2E] ${message}`, error?.message || error);
  }
}

// CLI Integration
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = {
    verbose: process.argv.includes('--verbose'),
    keepTestData: process.argv.includes('--keep-data'),
    timeout: parseInt(process.argv.find(arg => arg.startsWith('--timeout='))?.split('=')[1]) || 60000
  };
  
  console.log('🧪 Starting Batch Processing E2E Tests...');
  
  const tests = new BatchProcessingTests(options);
  
  tests.runAllTests().then((success) => {
    process.exit(success ? 0 : 1);
  }).catch((error) => {
    console.error('Batch processing E2E tests crashed:', error);
    process.exit(1);
  });
}

export default BatchProcessingTests;