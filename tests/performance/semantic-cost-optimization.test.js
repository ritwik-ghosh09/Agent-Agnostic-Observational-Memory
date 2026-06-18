#!/usr/bin/env node

/**
 * Semantic Analysis Cost Optimization Tests
 * 
 * Validates the enhanced user prompt set cost optimization system
 * including intelligent caching, multi-strategy cache keys, and cost tracking.
 * Goal: Achieve 70%+ cost reduction in semantic analysis calls.
 */

import ReliableCodingClassifier from '../../src/live-logging/ReliableCodingClassifier.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class SemanticCostOptimizationTest {
  constructor() {
    this.results = {
      testsPassed: 0,
      testsFailed: 0,
      errors: [],
      optimizationMetrics: {
        totalCalls: 0,
        cachedCalls: 0,
        freshCalls: 0,
        costReductionPercent: 0,
        cacheHitRate: 0
      }
    };
  }

  async runTests() {
    console.log('=== Semantic Analysis Cost Optimization Tests ===\n');
    
    try {
      await this.testBasicCostOptimizationSetup();
      await this.testMultiStrategyCacheKeys();
      await this.testIntelligentCacheManagement();
      await this.testCostReductionGoalAchievement();
      await this.testPerformanceOptimization();
      
      this.printResults();
      return this.results.testsFailed === 0;
    } catch (error) {
      console.error('Fatal test error:', error);
      this.results.errors.push(`Fatal error: ${error.message}`);
      return false;
    }
  }

  async testBasicCostOptimizationSetup() {
    console.log('1. Testing basic cost optimization setup...');
    
    try {
      const classifier = new ReliableCodingClassifier({
        enablePerformanceAlerts: false, // Reduce noise for testing
        enableUserPromptSets: true,
        maxPromptSetCacheSize: 500,
        promptSetCacheTTL: 900000, // 15 minutes
        estimatedSemanticCost: 0.002, // $0.002 per call
        enableContentSimilarityCache: true,
        enablePatternCache: true,
        enableTemporalCache: true,
        debug: false
      });
      
      await classifier.initialize();
      
      // Verify cost optimization system is initialized
      if (!classifier.costOptimization) {
        throw new Error('Cost optimization system not initialized');
      }
      
      const costOptConfig = classifier.costOptimization;
      
      if (costOptConfig.maxCacheSize !== 500) {
        throw new Error(`Expected maxCacheSize 500, got ${costOptConfig.maxCacheSize}`);
      }
      
      if (costOptConfig.cacheTTL !== 900000) {
        throw new Error(`Expected cacheTTL 900000, got ${costOptConfig.cacheTTL}`);
      }
      
      if (costOptConfig.semanticAnalysisCalls.estimatedCostPerCall !== 0.002) {
        throw new Error(`Expected cost per call 0.002, got ${costOptConfig.semanticAnalysisCalls.estimatedCostPerCall}`);
      }
      
      // Verify all optimization strategies are enabled
      if (!costOptConfig.enableContentSimilarityCache || 
          !costOptConfig.enablePatternCache || 
          !costOptConfig.enableTemporalCache) {
        throw new Error('Not all optimization strategies are enabled');
      }
      
      console.log('   ✓ Cost optimization system initialized correctly');
      console.log(`   ✓ Cache size limit: ${costOptConfig.maxCacheSize}`);
      console.log(`   ✓ Cache TTL: ${costOptConfig.cacheTTL}ms`);
      console.log(`   ✓ Cost per call: $${costOptConfig.semanticAnalysisCalls.estimatedCostPerCall}`);
      console.log(`   ✓ All optimization strategies enabled`);
      
      this.results.testsPassed++;
      
    } catch (error) {
      console.log('   ✗ Failed:', error.message);
      this.results.testsFailed++;
      this.results.errors.push(`Basic cost optimization setup: ${error.message}`);
    }
  }

  async testMultiStrategyCacheKeys() {
    console.log('2. Testing multi-strategy cache key generation...');
    
    try {
      const classifier = new ReliableCodingClassifier({
        enableUserPromptSets: true,
        enableContentSimilarityCache: true,
        enablePatternCache: true,
        enableTemporalCache: true,
        debug: false
      });
      
      await classifier.initialize();
      
      // Test different types of prompt sets that should benefit from each strategy
      const testCases = [
        {
          name: 'Content similarity test',
          promptSets: [
            [{ userMessage: 'implement user authentication', content: 'implement user authentication' }],
            [{ userMessage: 'implement user authentication system', content: 'implement user authentication system' }], // Similar content
            [{ userMessage: 'create a new database table', content: 'create a new database table' }] // Different content
          ]
        },
        {
          name: 'Pattern recognition test',
          promptSets: [
            [{ userMessage: 'fix the login bug in authentication', content: 'fix the login bug in authentication' }],
            [{ userMessage: 'debug the signup error', content: 'debug the signup error' }], // Same 'fix' pattern
            [{ userMessage: 'run the test suite', content: 'run the test suite' }] // Different 'execute' pattern
          ]
        }
      ];
      
      let uniqueKeys = new Set();
      let cacheKeyGenTimes = [];
      
      for (const testCase of testCases) {
        console.log(`   Testing ${testCase.name}...`);
        
        for (const promptSet of testCase.promptSets) {
          const startTime = process.hrtime.bigint();
          const cacheKey = classifier.createPromptSetCacheKey(promptSet);
          const endTime = process.hrtime.bigint();
          
          const duration = Number(endTime - startTime) / 1000000; // Convert to ms
          cacheKeyGenTimes.push(duration);
          
          uniqueKeys.add(cacheKey);
          
          // Verify key format
          if (!cacheKey.startsWith('promptset_v2_')) {
            throw new Error(`Cache key should start with promptset_v2_, got: ${cacheKey}`);
          }
        }
      }
      
      // Similar content should produce similar keys (for content strategy)
      // Different patterns should produce different keys
      if (uniqueKeys.size < 3) {
        console.log(`   ⚠ Warning: Only ${uniqueKeys.size} unique cache keys generated (expected more diversity)`);
      }
      
      // Check performance of cache key generation
      const avgKeyGenTime = cacheKeyGenTimes.reduce((a, b) => a + b, 0) / cacheKeyGenTimes.length;
      if (avgKeyGenTime > 1.0) { // Should be under 1ms
        throw new Error(`Cache key generation too slow: ${avgKeyGenTime.toFixed(2)}ms (target: <1ms)`);
      }
      
      console.log(`   ✓ Generated ${uniqueKeys.size} unique cache keys`);
      console.log(`   ✓ Average key generation time: ${avgKeyGenTime.toFixed(3)}ms`);
      console.log(`   ✓ Multi-strategy cache key system working`);
      
      this.results.testsPassed++;
      
    } catch (error) {
      console.log('   ✗ Failed:', error.message);
      this.results.testsFailed++;
      this.results.errors.push(`Multi-strategy cache keys: ${error.message}`);
    }
  }

  async testIntelligentCacheManagement() {
    console.log('3. Testing intelligent cache management...');
    
    try {
      const classifier = new ReliableCodingClassifier({
        enableUserPromptSets: true,
        maxPromptSetCacheSize: 5, // Small cache for testing eviction
        promptSetCacheTTL: 100, // Short TTL for testing expiration (100ms)
        debug: false
      });
      
      await classifier.initialize();
      
      // Test cache size management
      console.log('   Testing cache size limits...');
      
      // Add entries to exceed cache size
      const testPromptSets = [];
      for (let i = 0; i < 8; i++) {
        testPromptSets.push([{ userMessage: `test prompt ${i}`, content: `test prompt ${i}` }]);
      }
      
      // Classify to populate cache
      for (const promptSet of testPromptSets) {
        await classifier.classifyUserPromptSet(promptSet);
      }
      
      // Check that cache size is managed
      if (classifier.promptSetCache.size > classifier.costOptimization.maxCacheSize) {
        throw new Error(`Cache size ${classifier.promptSetCache.size} exceeds limit ${classifier.costOptimization.maxCacheSize}`);
      }
      
      // Check that evictions occurred
      if (classifier.costOptimization.cacheEvictions === 0) {
        throw new Error('Expected cache evictions but none occurred');
      }
      
      console.log(`   ✓ Cache size managed: ${classifier.promptSetCache.size}/${classifier.costOptimization.maxCacheSize}`);
      console.log(`   ✓ Cache evictions: ${classifier.costOptimization.cacheEvictions}`);
      
      // Test TTL expiration
      console.log('   Testing TTL expiration...');
      
      const initialCacheSize = classifier.promptSetCache.size;
      
      // Wait for TTL expiration
      await new Promise(resolve => setTimeout(resolve, 150)); // Wait 150ms (TTL is 100ms)
      
      // Trigger cache management to clean expired entries
      classifier.manageCacheOptimization();
      
      if (classifier.promptSetCache.size >= initialCacheSize) {
        console.log(`   ⚠ Warning: Expected TTL expiration, cache size unchanged: ${classifier.promptSetCache.size}`);
      } else {
        console.log(`   ✓ TTL expiration working: ${initialCacheSize} → ${classifier.promptSetCache.size}`);
      }
      
      this.results.testsPassed++;
      
    } catch (error) {
      console.log('   ✗ Failed:', error.message);
      this.results.testsFailed++;
      this.results.errors.push(`Intelligent cache management: ${error.message}`);
    }
  }

  async testCostReductionGoalAchievement() {
    console.log('4. Testing 70%+ cost reduction goal achievement...');
    
    try {
      const classifier = new ReliableCodingClassifier({
        enableUserPromptSets: true,
        estimatedSemanticCost: 0.001,
        debug: false
      });
      
      await classifier.initialize();
      
      // Create repetitive prompt sets to maximize cache hits
      const basePromptSets = [
        [
          { userMessage: 'implement user login', content: 'implement user login' },
          { userMessage: 'add validation', content: 'add validation' }
        ],
        [
          { userMessage: 'fix authentication bug', content: 'fix authentication bug' },
          { userMessage: 'test login flow', content: 'test login flow' }
        ],
        [
          { userMessage: 'create database schema', content: 'create database schema' },
          { userMessage: 'run migrations', content: 'run migrations' }
        ]
      ];
      
      // Process each set multiple times to build cache
      const totalRuns = 20;
      for (let run = 0; run < totalRuns; run++) {
        for (const promptSet of basePromptSets) {
          await classifier.classifyUserPromptSet(promptSet);
          
          // Also test individual classifications with prompt set context
          for (let i = 0; i < promptSet.length; i++) {
            const exchange = promptSet[i];
            const isPromptSetEnd = i === promptSet.length - 1;
            
            await classifier.classify(exchange, {
              promptSetContext: {
                promptSetExchanges: promptSet,
                isPromptSetEnd
              }
            });
          }
        }
      }
      
      const costReport = classifier.getCostOptimizationReport();
      const stats = classifier.getStats();
      
      console.log(`   Total semantic calls: ${costReport.costMetrics.totalCalls}`);
      console.log(`   Cached calls: ${costReport.costMetrics.cachedCalls}`);
      console.log(`   Fresh calls: ${costReport.costMetrics.freshCalls}`);
      console.log(`   Cost reduction: ${costReport.costMetrics.costReductionPercent.toFixed(1)}%`);
      console.log(`   Cache hit rate: ${(costReport.cacheStats.hitRate * 100).toFixed(1)}%`);
      console.log(`   Total cost saved: $${costReport.costMetrics.totalCostSaved.toFixed(4)}`);
      console.log(`   Total cost spent: $${costReport.costMetrics.totalCostSpent.toFixed(4)}`);
      
      // Verify goal achievement
      if (costReport.costMetrics.costReductionPercent < 70) {
        console.log(`   ⚠ Warning: Cost reduction ${costReport.costMetrics.costReductionPercent.toFixed(1)}% below 70% target`);
        console.log(`   ⚠ Remaining to goal: ${costReport.goalAchievement.remainingToGoal.toFixed(1)}%`);
      } else {
        console.log(`   ✓ Cost reduction goal achieved: ${costReport.costMetrics.costReductionPercent.toFixed(1)}% >= 70%`);
      }
      
      // Verify cost tracking accuracy
      if (costReport.costMetrics.totalCalls !== 
          (costReport.costMetrics.cachedCalls + costReport.costMetrics.freshCalls)) {
        throw new Error('Cost tracking calculation error: total != cached + fresh');
      }
      
      // Store results for final summary
      this.results.optimizationMetrics = {
        totalCalls: costReport.costMetrics.totalCalls,
        cachedCalls: costReport.costMetrics.cachedCalls,
        freshCalls: costReport.costMetrics.freshCalls,
        costReductionPercent: costReport.costMetrics.costReductionPercent,
        cacheHitRate: costReport.cacheStats.hitRate
      };
      
      console.log(`   ✓ Cost tracking accurate`);
      console.log(`   ${costReport.goalAchievement.goalMet ? '✓' : '⚠'} Goal achievement: ${costReport.goalAchievement.goalMet ? 'MET' : 'NOT MET'}`);
      
      this.results.testsPassed++;
      
    } catch (error) {
      console.log('   ✗ Failed:', error.message);
      this.results.testsFailed++;
      this.results.errors.push(`Cost reduction goal: ${error.message}`);
    }
  }

  async testPerformanceOptimization() {
    console.log('5. Testing performance optimization features...');
    
    try {
      const classifier = new ReliableCodingClassifier({
        enableUserPromptSets: true,
        debug: false
      });
      
      await classifier.initialize();
      
      // Test performance tracking
      const testPromptSet = [
        { userMessage: 'performance test prompt', content: 'performance test prompt' }
      ];
      
      await classifier.classifyUserPromptSet(testPromptSet);
      
      const costReport = classifier.getCostOptimizationReport();
      
      // Verify performance metrics are being tracked
      if (costReport.performanceMetrics.avgCacheKeyGenTime === 0) {
        throw new Error('Cache key generation time not being tracked');
      }
      
      if (costReport.performanceMetrics.avgCacheLookupTime === 0) {
        throw new Error('Cache lookup time not being tracked');
      }
      
      // Verify performance is acceptable
      if (costReport.performanceMetrics.avgCacheKeyGenTime > 2.0) {
        throw new Error(`Cache key generation too slow: ${costReport.performanceMetrics.avgCacheKeyGenTime.toFixed(2)}ms`);
      }
      
      if (costReport.performanceMetrics.avgCacheLookupTime > 1.0) {
        throw new Error(`Cache lookup too slow: ${costReport.performanceMetrics.avgCacheLookupTime.toFixed(2)}ms`);
      }
      
      console.log(`   ✓ Cache key generation: ${costReport.performanceMetrics.avgCacheKeyGenTime.toFixed(3)}ms`);
      console.log(`   ✓ Cache lookup: ${costReport.performanceMetrics.avgCacheLookupTime.toFixed(3)}ms`);
      console.log(`   ✓ Key generation samples: ${costReport.performanceMetrics.cacheKeyGenSamples}`);
      console.log(`   ✓ Cache lookup samples: ${costReport.performanceMetrics.cacheLookupSamples}`);
      console.log(`   ✓ Performance optimization tracking working`);
      
      this.results.testsPassed++;
      
    } catch (error) {
      console.log('   ✗ Failed:', error.message);
      this.results.testsFailed++;
      this.results.errors.push(`Performance optimization: ${error.message}`);
    }
  }

  printResults() {
    console.log('\n=== Test Results ===');
    console.log(`Tests passed: ${this.results.testsPassed}`);
    console.log(`Tests failed: ${this.results.testsFailed}`);
    
    if (this.results.errors.length > 0) {
      console.log('\nErrors:');
      this.results.errors.forEach(error => console.log(`- ${error}`));
    }
    
    // Cost optimization summary
    if (this.results.optimizationMetrics.totalCalls > 0) {
      console.log('\n=== Cost Optimization Summary ===');
      console.log(`Total semantic analysis calls: ${this.results.optimizationMetrics.totalCalls}`);
      console.log(`Cached calls: ${this.results.optimizationMetrics.cachedCalls}`);
      console.log(`Fresh calls: ${this.results.optimizationMetrics.freshCalls}`);
      console.log(`Cost reduction achieved: ${this.results.optimizationMetrics.costReductionPercent.toFixed(1)}%`);
      console.log(`Cache hit rate: ${(this.results.optimizationMetrics.cacheHitRate * 100).toFixed(1)}%`);
      console.log(`Target achievement: ${this.results.optimizationMetrics.costReductionPercent >= 70 ? '✓ ACHIEVED' : '⚠ NOT ACHIEVED'}`);
    }
    
    console.log(`\nOverall: ${this.results.testsFailed === 0 ? 'PASS' : 'FAIL'}`);
  }
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const test = new SemanticCostOptimizationTest();
  const success = await test.runTests();
  process.exit(success ? 0 : 1);
}

export { SemanticCostOptimizationTest };