#!/usr/bin/env node

/**
 * Multi-User Collision Prevention E2E Tests
 * 
 * Comprehensive test suite for ensuring multiple users can use the Live Session
 * Logging system simultaneously without filename collisions or hash conflicts.
 * 
 * Tests cover:
 * - User hash generation consistency and uniqueness
 * - Filename collision prevention across multiple users
 * - Concurrent operation safety
 * - Edge cases and error handling
 * - Multi-user coordination scenarios
 * 
 * Requirements: 5.3 - Multi-user collision prevention
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import UserHashGenerator from '../../src/live-logging/user-hash-generator.js';
import { generateLSLFilename } from '../../scripts/timezone-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MultiUserCollisionTest {
  constructor(options = {}) {
    this.options = {
      verbose: false,
      keepData: false,
      timeout: 30000,
      ...options
    };
    
    this.testResults = [];
    this.testData = new Map();
    this.originalEnv = { ...process.env };
    
    this.log('Multi-User Collision Prevention Test Suite initialized');
  }

  log(message) {
    if (this.options.verbose) {
      console.log(`[MultiUserCollision] ${new Date().toISOString()} ${message}`);
    }
  }

  async runAllTests() {
    this.log('Starting comprehensive multi-user collision prevention tests');
    
    const tests = [
      'basicUserHashGeneration',
      'userHashConsistency',
      'multipleUserHashUniqueness',
      'filenameCollisionPrevention',
      'concurrentUserOperations',
      'environmentVariableFallback',
      'edgeCaseHandling',
      'multiUserCoordination'
    ];

    let passed = 0;
    let failed = 0;

    for (const testName of tests) {
      try {
        this.log(`Running test: ${testName}`);
        const result = await this[testName]();
        
        if (result.success) {
          passed++;
          this.log(`✓ ${testName} - PASSED`);
        } else {
          failed++;
          this.log(`✗ ${testName} - FAILED: ${result.error}`);
        }
        
        this.testResults.push({
          test: testName,
          success: result.success,
          error: result.error,
          details: result.details,
          duration: result.duration
        });
        
      } catch (error) {
        failed++;
        this.log(`✗ ${testName} - ERROR: ${error.message}`);
        this.testResults.push({
          test: testName,
          success: false,
          error: error.message,
          duration: 0
        });
      }
    }

    // Cleanup unless keeping data
    if (!this.options.keepData) {
      await this.cleanup();
    }

    this.log(`Tests completed: ${passed} passed, ${failed} failed`);
    
    return {
      success: failed === 0,
      passed,
      failed,
      total: tests.length,
      results: this.testResults
    };
  }

  async basicUserHashGeneration() {
    const startTime = Date.now();
    
    try {
      // Test hash generation with current environment
      const generator = new UserHashGenerator({ debug: this.options.verbose });
      const hash = generator.generateUserHash();
      
      // Validate hash format
      if (!generator.validateHash(hash)) {
        return {
          success: false,
          error: `Generated hash "${hash}" failed validation`,
          duration: Date.now() - startTime
        };
      }
      
      // Test hash properties
      if (hash.length !== 6) {
        return {
          success: false,
          error: `Hash length ${hash.length}, expected 6`,
          duration: Date.now() - startTime
        };
      }
      
      if (!/^[a-zA-Z]/.test(hash)) {
        return {
          success: false,
          error: `Hash "${hash}" doesn't start with a letter`,
          duration: Date.now() - startTime
        };
      }
      
      if (!/^[a-zA-Z0-9]+$/.test(hash)) {
        return {
          success: false,
          error: `Hash "${hash}" contains non-alphanumeric characters`,
          duration: Date.now() - startTime
        };
      }
      
      // Store hash for other tests
      this.testData.set('currentUserHash', hash);
      
      return {
        success: true,
        details: { generatedHash: hash },
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async userHashConsistency() {
    const startTime = Date.now();
    
    try {
      const generator = new UserHashGenerator({ debug: this.options.verbose });
      const iterations = 50;
      const hashes = new Set();
      
      // Generate multiple hashes and ensure they're all identical
      for (let i = 0; i < iterations; i++) {
        const hash = generator.generateUserHash();
        hashes.add(hash);
      }
      
      if (hashes.size !== 1) {
        return {
          success: false,
          error: `Hash inconsistency: generated ${hashes.size} different hashes in ${iterations} iterations`,
          details: { uniqueHashes: Array.from(hashes) },
          duration: Date.now() - startTime
        };
      }
      
      // Test built-in consistency checker
      const consistencyResult = generator.testConsistency(null, 25);
      if (!consistencyResult) {
        return {
          success: false,
          error: 'Built-in consistency test failed',
          duration: Date.now() - startTime
        };
      }
      
      return {
        success: true,
        details: { 
          iterations,
          consistentHash: Array.from(hashes)[0] 
        },
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async multipleUserHashUniqueness() {
    const startTime = Date.now();
    
    try {
      const testUsers = [
        { USER: 'alice', USERNAME: undefined, LOGNAME: undefined },
        { USER: 'bob', USERNAME: undefined, LOGNAME: undefined },
        { USER: 'charlie', USERNAME: undefined, LOGNAME: undefined },
        { USER: undefined, USERNAME: 'david', LOGNAME: undefined },
        { USER: undefined, USERNAME: undefined, LOGNAME: 'eve' },
        { USER: 'frank-long-username', USERNAME: undefined, LOGNAME: undefined },
        { USER: 'test.user', USERNAME: undefined, LOGNAME: undefined },
        { USER: '123numeric', USERNAME: undefined, LOGNAME: undefined }
      ];
      
      const userHashes = new Map();
      const hashCollisions = [];
      
      for (const testUser of testUsers) {
        // Simulate different user environment
        const originalEnv = { ...process.env };
        Object.assign(process.env, testUser);
        
        try {
          const generator = new UserHashGenerator({ debug: this.options.verbose });
          const hash = generator.generateUserHash();
          const userIdentifier = generator.getUserIdentifier();
          
          // Check for hash collisions
          if (userHashes.has(hash)) {
            hashCollisions.push({
              hash,
              user1: userHashes.get(hash),
              user2: { testUser, userIdentifier }
            });
          } else {
            userHashes.set(hash, { testUser, userIdentifier });
          }
          
        } finally {
          // Restore original environment
          Object.assign(process.env, originalEnv);
        }
      }
      
      if (hashCollisions.length > 0) {
        return {
          success: false,
          error: `Hash collisions detected: ${hashCollisions.length}`,
          details: { collisions: hashCollisions },
          duration: Date.now() - startTime
        };
      }
      
      if (userHashes.size !== testUsers.length) {
        return {
          success: false,
          error: `Expected ${testUsers.length} unique hashes, got ${userHashes.size}`,
          details: { uniqueHashes: userHashes.size },
          duration: Date.now() - startTime
        };
      }
      
      return {
        success: true,
        details: { 
          testedUsers: testUsers.length,
          uniqueHashes: userHashes.size,
          hashSamples: Array.from(userHashes.keys()).slice(0, 3)
        },
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async filenameCollisionPrevention() {
    const startTime = Date.now();
    
    try {
      const timestamp = Date.now();
      const projectName = 'test-project';
      const targetProject = '/tmp/test-target';
      const sourceProject = '/tmp/test-source';
      
      const testUsers = [
        { USER: 'user1' },
        { USER: 'user2' },
        { USER: 'user3' }
      ];
      
      const generatedFilenames = new Set();
      const filenameCollisions = [];
      
      for (const testUser of testUsers) {
        // Simulate different user environment
        const originalEnv = { ...process.env };
        Object.assign(process.env, testUser);
        
        try {
          // Generate filename for same timestamp (collision potential)
          const filename = generateLSLFilename(
            timestamp, 
            projectName, 
            targetProject, 
            sourceProject,
            { debug: this.options.verbose }
          );
          
          // Check for filename collisions
          if (generatedFilenames.has(filename)) {
            filenameCollisions.push({
              filename,
              user: testUser.USER
            });
          } else {
            generatedFilenames.add(filename);
          }
          
        } finally {
          // Restore original environment
          Object.assign(process.env, originalEnv);
        }
      }
      
      if (filenameCollisions.length > 0) {
        return {
          success: false,
          error: `Filename collisions detected: ${filenameCollisions.length}`,
          details: { collisions: filenameCollisions },
          duration: Date.now() - startTime
        };
      }
      
      // Test filename format consistency
      const filenameArray = Array.from(generatedFilenames);
      const filenamePattern = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{4}_[a-zA-Z][a-zA-Z0-9]{5}(_from-[^.]+)?\.md$/;
      
      for (const filename of filenameArray) {
        if (!filenamePattern.test(filename)) {
          return {
            success: false,
            error: `Invalid filename format: ${filename}`,
            duration: Date.now() - startTime
          };
        }
      }
      
      return {
        success: true,
        details: { 
          testedUsers: testUsers.length,
          uniqueFilenames: generatedFilenames.size,
          sampleFilenames: filenameArray.slice(0, 2)
        },
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async concurrentUserOperations() {
    const startTime = Date.now();
    
    try {
      const concurrentUsers = 5;
      const operationsPerUser = 10;
      
      const promises = [];
      const results = [];
      
      // Simulate concurrent hash generation by multiple users
      for (let userId = 0; userId < concurrentUsers; userId++) {
        const promise = this.simulateConcurrentUser(userId, operationsPerUser);
        promises.push(promise);
      }
      
      const concurrentResults = await Promise.all(promises);
      
      // Analyze results for collisions
      const allHashes = new Set();
      const allFilenames = new Set();
      let totalOperations = 0;
      
      for (const userResult of concurrentResults) {
        if (!userResult.success) {
          return {
            success: false,
            error: `Concurrent user operation failed: ${userResult.error}`,
            duration: Date.now() - startTime
          };
        }
        
        for (const hash of userResult.hashes) {
          if (allHashes.has(hash)) {
            return {
              success: false,
              error: `Hash collision in concurrent operations: ${hash}`,
              duration: Date.now() - startTime
            };
          }
          allHashes.add(hash);
        }
        
        for (const filename of userResult.filenames) {
          if (allFilenames.has(filename)) {
            return {
              success: false,
              error: `Filename collision in concurrent operations: ${filename}`,
              duration: Date.now() - startTime
            };
          }
          allFilenames.add(filename);
        }
        
        totalOperations += userResult.operations;
      }
      
      return {
        success: true,
        details: {
          concurrentUsers,
          operationsPerUser,
          totalOperations,
          uniqueHashes: allHashes.size,
          uniqueFilenames: allFilenames.size
        },
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async simulateConcurrentUser(userId, operations) {
    return new Promise((resolve) => {
      // Simulate different user environment
      const originalEnv = { ...process.env };
      Object.assign(process.env, { USER: `concurrent-user-${userId}` });
      
      try {
        const generator = new UserHashGenerator({ debug: false });
        const hashes = new Set();
        const filenames = new Set();
        
        for (let op = 0; op < operations; op++) {
          const hash = generator.generateUserHash();
          hashes.add(hash);
          
          const timestamp = Date.now() + op * 1000; // Different timestamps
          const filename = generateLSLFilename(
            timestamp,
            'concurrent-test',
            '/tmp/target',
            '/tmp/source'
          );
          filenames.add(filename);
        }
        
        resolve({
          success: true,
          userId,
          operations,
          hashes: Array.from(hashes),
          filenames: Array.from(filenames)
        });
        
      } catch (error) {
        resolve({
          success: false,
          error: error.message
        });
      } finally {
        // Restore original environment
        Object.assign(process.env, originalEnv);
      }
    });
  }

  async environmentVariableFallback() {
    const startTime = Date.now();
    
    try {
      const fallbackScenarios = [
        { description: 'No USER, has USERNAME', env: { USER: undefined, USERNAME: 'fallback-user1' } },
        { description: 'No USER/USERNAME, has LOGNAME', env: { USER: undefined, USERNAME: undefined, LOGNAME: 'fallback-user2' } },
        { description: 'No env vars, use hostname', env: { USER: undefined, USERNAME: undefined, LOGNAME: undefined } },
        { description: 'Empty USER var', env: { USER: '' } },
        { description: 'Whitespace USER var', env: { USER: '   ' } },
        { description: 'Undefined string USER', env: { USER: 'undefined' } }
      ];
      
      const fallbackResults = [];
      
      for (const scenario of fallbackScenarios) {
        // Backup and modify environment
        const originalEnv = { ...process.env };
        
        // Clear specific env vars
        delete process.env.USER;
        delete process.env.USERNAME;
        delete process.env.LOGNAME;
        
        // Set test environment
        Object.assign(process.env, scenario.env);
        
        try {
          const generator = new UserHashGenerator({ debug: this.options.verbose });
          const hash = generator.generateUserHash();
          const userIdentifier = generator.getUserIdentifier();
          
          if (!generator.validateHash(hash)) {
            return {
              success: false,
              error: `Invalid hash in fallback scenario: ${scenario.description}`,
              duration: Date.now() - startTime
            };
          }
          
          fallbackResults.push({
            scenario: scenario.description,
            userIdentifier,
            hash,
            success: true
          });
          
        } finally {
          // Restore original environment
          Object.assign(process.env, originalEnv);
        }
      }
      
      // Check that all fallback scenarios produced valid hashes
      // Note: Some scenarios may produce the same hash when they fall back to the same identifier (e.g., hostname)
      const fallbackHashes = fallbackResults.map(r => r.hash);
      const uniqueFallbackHashes = new Set(fallbackHashes);
      
      // Group scenarios by their user identifier to understand expected duplicates
      const identifierGroups = new Map();
      for (const result of fallbackResults) {
        const identifier = result.userIdentifier;
        if (!identifierGroups.has(identifier)) {
          identifierGroups.set(identifier, []);
        }
        identifierGroups.get(identifier).push(result);
      }
      
      // Verify that scenarios with the same identifier produce the same hash (expected behavior)
      for (const [identifier, results] of identifierGroups) {
        const hashesForIdentifier = results.map(r => r.hash);
        const uniqueHashesForIdentifier = new Set(hashesForIdentifier);
        
        if (uniqueHashesForIdentifier.size !== 1) {
          return {
            success: false,
            error: `Inconsistent hashes for identifier "${identifier}": ${Array.from(uniqueHashesForIdentifier)}`,
            details: { fallbackResults },
            duration: Date.now() - startTime
          };
        }
      }
      
      // Verify that different identifiers produce different hashes
      const uniqueIdentifiers = new Set(fallbackResults.map(r => r.userIdentifier));
      if (uniqueFallbackHashes.size !== uniqueIdentifiers.size) {
        return {
          success: false,
          error: `Hash collision between different identifiers: ${uniqueIdentifiers.size} identifiers, ${uniqueFallbackHashes.size} unique hashes`,
          details: { fallbackResults },
          duration: Date.now() - startTime
        };
      }
      
      return {
        success: true,
        details: {
          scenariosTested: fallbackScenarios.length,
          allScenariosSucceeded: fallbackResults.every(r => r.success),
          uniqueHashes: uniqueFallbackHashes.size,
          fallbackResults
        },
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async edgeCaseHandling() {
    const startTime = Date.now();
    
    try {
      const edgeCases = [
        { description: 'Very long username', USER: 'a'.repeat(100) },
        { description: 'Special characters', USER: 'user@domain.com' },
        { description: 'Unicode characters', USER: 'ユーザー' },
        { description: 'Mixed case', USER: 'MixedCaseUser' },
        { description: 'Numbers only', USER: '12345' },
        { description: 'Dots and dashes', USER: 'user.name-123' },
        { description: 'Single character', USER: 'a' }
      ];
      
      const edgeCaseResults = [];
      
      for (const edgeCase of edgeCases) {
        // Set test environment
        const originalEnv = { ...process.env };
        Object.assign(process.env, edgeCase);
        
        try {
          const generator = new UserHashGenerator({ debug: this.options.verbose });
          const hash = generator.generateUserHash();
          
          if (!generator.validateHash(hash)) {
            return {
              success: false,
              error: `Edge case "${edgeCase.description}" produced invalid hash: ${hash}`,
              duration: Date.now() - startTime
            };
          }
          
          // Test filename generation with edge case hash
          const filename = generateLSLFilename(
            Date.now(),
            'edge-test',
            '/tmp/target',
            '/tmp/source'
          );
          
          if (!filename.includes(hash)) {
            return {
              success: false,
              error: `Edge case "${edgeCase.description}" hash not found in filename: ${filename}`,
              duration: Date.now() - startTime
            };
          }
          
          edgeCaseResults.push({
            description: edgeCase.description,
            userInput: edgeCase.USER,
            generatedHash: hash,
            filename: path.basename(filename),
            success: true
          });
          
        } finally {
          // Restore original environment
          Object.assign(process.env, originalEnv);
        }
      }
      
      return {
        success: true,
        details: {
          edgeCasesTested: edgeCases.length,
          allEdgeCasesSucceeded: edgeCaseResults.every(r => r.success),
          edgeCaseResults
        },
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async multiUserCoordination() {
    const startTime = Date.now();
    
    try {
      // Create temporary test directories
      const testDir = '/tmp/multi-user-collision-test';
      const user1Dir = path.join(testDir, 'user1');
      const user2Dir = path.join(testDir, 'user2');
      
      // Create test directories
      fs.mkdirSync(testDir, { recursive: true });
      fs.mkdirSync(user1Dir, { recursive: true });
      fs.mkdirSync(user2Dir, { recursive: true });
      
      try {
        // Create mock transcript data for testing
        const mockTranscript = JSON.stringify({
          id: 'test-exchange',
          timestamp: Date.now(),
          content: 'Mock transcript content for testing'
        });
        
        const user1TranscriptPath = path.join(user1Dir, 'test-transcript.jsonl');
        const user2TranscriptPath = path.join(user2Dir, 'test-transcript.jsonl');
        
        fs.writeFileSync(user1TranscriptPath, mockTranscript + '\n');
        fs.writeFileSync(user2TranscriptPath, mockTranscript + '\n');
        
        // Test concurrent enhanced-transcript-monitor processes
        const coordinationResults = await this.testEnhancedTranscriptMonitorCoordination(
          user1TranscriptPath,
          user2TranscriptPath
        );
        
        return {
          success: coordinationResults.success,
          error: coordinationResults.error,
          details: coordinationResults.details,
          duration: Date.now() - startTime
        };
        
      } finally {
        // Cleanup test directories
        if (!this.options.keepData) {
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      }
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async testEnhancedTranscriptMonitorCoordination(user1Path, user2Path) {
    return new Promise((resolve) => {
      try {
        // This is a simplified coordination test
        // In a real scenario, we'd spawn actual enhanced-transcript-monitor processes
        
        // Simulate different users generating hashes and filenames
        const originalEnv = { ...process.env };
        
        // User 1 simulation
        Object.assign(process.env, { USER: 'coordination-user1' });
        const generator1 = new UserHashGenerator({ debug: this.options.verbose });
        const hash1 = generator1.generateUserHash();
        const filename1 = generateLSLFilename(Date.now(), 'coord-test', '/tmp/target', '/tmp/source');
        
        // User 2 simulation
        Object.assign(process.env, { USER: 'coordination-user2' });
        const generator2 = new UserHashGenerator({ debug: this.options.verbose });
        const hash2 = generator2.generateUserHash();
        const filename2 = generateLSLFilename(Date.now(), 'coord-test', '/tmp/target', '/tmp/source');
        
        // Restore environment
        Object.assign(process.env, originalEnv);
        
        // Verify coordination - users should have different hashes and filenames
        if (hash1 === hash2) {
          resolve({
            success: false,
            error: `User coordination failed: both users generated same hash ${hash1}`,
            details: { hash1, hash2, filename1, filename2 }
          });
          return;
        }
        
        if (filename1 === filename2) {
          resolve({
            success: false,
            error: `User coordination failed: both users generated same filename ${filename1}`,
            details: { hash1, hash2, filename1, filename2 }
          });
          return;
        }
        
        resolve({
          success: true,
          details: {
            user1: { hash: hash1, filename: path.basename(filename1) },
            user2: { hash: hash2, filename: path.basename(filename2) },
            hashesUnique: hash1 !== hash2,
            filenamesUnique: filename1 !== filename2
          }
        });
        
      } catch (error) {
        resolve({
          success: false,
          error: error.message
        });
      }
    });
  }

  async cleanup() {
    this.log('Cleaning up test data');
    
    try {
      // Restore original environment
      Object.assign(process.env, this.originalEnv);
      
      // Clean up any temporary files created during testing
      const tempDirs = ['/tmp/multi-user-collision-test'];
      
      for (const dir of tempDirs) {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          this.log(`Cleaned up temporary directory: ${dir}`);
        }
      }
      
    } catch (error) {
      this.log(`Cleanup warning: ${error.message}`);
    }
  }

  generateReport() {
    const report = {
      testSuite: 'Multi-User Collision Prevention E2E Tests',
      timestamp: new Date().toISOString(),
      summary: {
        total: this.testResults.length,
        passed: this.testResults.filter(r => r.success).length,
        failed: this.testResults.filter(r => !r.success).length,
        duration: this.testResults.reduce((sum, r) => sum + r.duration, 0)
      },
      results: this.testResults,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        currentUser: process.env.USER || 'unknown'
      }
    };
    
    return report;
  }
}

// CLI Integration
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const options = {
    verbose: args.includes('--verbose') || args.includes('-v'),
    keepData: args.includes('--keep-data') || args.includes('-k'),
    timeout: parseInt(args.find(arg => arg.startsWith('--timeout='))?.split('=')[1]) || 30000
  };
  
  const tester = new MultiUserCollisionTest(options);
  
  console.log('🔒 Multi-User Collision Prevention E2E Tests');
  console.log('=============================================');
  console.log('');
  
  tester.runAllTests()
    .then(results => {
      console.log('');
      console.log('📊 Test Results Summary:');
      console.log(`   Total: ${results.total}`);
      console.log(`   Passed: ${results.passed}`);
      console.log(`   Failed: ${results.failed}`);
      console.log('');
      
      if (options.verbose || results.failed > 0) {
        const report = tester.generateReport();
        console.log('📋 Detailed Report:');
        console.log(JSON.stringify(report, null, 2));
      }
      
      process.exit(results.success ? 0 : 1);
    })
    .catch(error => {
      console.error('❌ Test suite failed:', error.message);
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    });
}

export default MultiUserCollisionTest;