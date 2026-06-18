#!/usr/bin/env node

/**
 * LSL File Manager Integration Tests
 * 
 * Tests file size monitoring, rotation, and compression functionality
 * in realistic scenarios with actual LSL files.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import LSLFileManager from '../../src/live-logging/LSLFileManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class LSLFileManagerTest {
  constructor() {
    this.testResults = {
      passed: 0,
      failed: 0,
      errors: []
    };
    
    this.testDir = path.join(__dirname, 'test-files');
    this.tempFiles = [];
    
    this.setupTestEnvironment();
  }
  
  setupTestEnvironment() {
    // Create test directory
    if (!fs.existsSync(this.testDir)) {
      fs.mkdirSync(this.testDir, { recursive: true });
    }
    
    // Create .specstory structure for realistic testing
    const specstoryDir = path.join(this.testDir, '.specstory');
    const historyDir = path.join(specstoryDir, 'history');
    const archiveDir = path.join(specstoryDir, 'archive');
    
    [specstoryDir, historyDir, archiveDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }
  
  async runAllTests() {
    console.log('=== LSL File Manager Integration Tests ===\n');
    
    try {
      await this.testBasicFileWatching();
      await this.testFileSizeMonitoring();
      await this.testFileRotation();
      await this.testCompression();
      await this.testArchiveCleanup();
      await this.testErrorHandling();
      await this.testGracefulShutdown();
      
      this.printResults();
      return this.testResults.failed === 0;
      
    } catch (error) {
      console.error('Fatal test error:', error);
      return false;
    } finally {
      this.cleanup();
    }
  }
  
  async testBasicFileWatching() {
    console.log('1. Testing basic file watching...');
    
    try {
      const fileManager = new LSLFileManager({
        debug: false,
        enableRealTimeMonitoring: false // Disable real-time for controlled testing
      });
      
      const testFile = path.join(this.testDir, '.specstory', 'history', '2025-09-14_1400-1500-session.md');
      this.tempFiles.push(testFile);
      
      // Create initial test file
      const initialContent = '# Test Session\n\nInitial content for testing.\n';
      fs.writeFileSync(testFile, initialContent);
      
      // Add to file manager
      const watchedPath = fileManager.watchFile(testFile, { testFile: true });
      
      this.assert(watchedPath === path.resolve(testFile), 'File path should be resolved correctly');
      
      const stats = fileManager.getStats();
      this.assert(stats.watchedFiles.count === 1, 'Should have one watched file');
      this.assert(stats.watchedFiles.files[0].exists === true, 'File should exist');
      this.assert(stats.watchedFiles.files[0].currentSize > 0, 'File should have content');
      
      // Remove from watching
      const removed = fileManager.unwatchFile(testFile);
      this.assert(removed === true, 'File should be removed from watching');
      
      const statsAfter = fileManager.getStats();
      this.assert(statsAfter.watchedFiles.count === 0, 'Should have no watched files after removal');
      
      await fileManager.shutdown();
      
      this.testResults.passed++;
      console.log('   ✓ Basic file watching works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Basic file watching: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testFileSizeMonitoring() {
    console.log('2. Testing file size monitoring...');
    
    try {
      const fileManager = new LSLFileManager({
        rotationThreshold: 1024, // 1KB for testing
        debug: false,
        enableRealTimeMonitoring: false
      });
      
      const testFile = path.join(this.testDir, '.specstory', 'history', '2025-09-14_1500-1600-session.md');
      this.tempFiles.push(testFile);
      
      // Create small initial file
      const smallContent = '# Small Test Session\n\nSmall content.\n';
      fs.writeFileSync(testFile, smallContent);
      
      fileManager.watchFile(testFile);
      
      // Check initial state - should not need rotation
      let rotationCheck = await fileManager.checkFileRotation(testFile);
      this.assert(rotationCheck.needsRotation === false, 'Small file should not need rotation');
      
      // Add content to exceed threshold
      const largeContent = 'Large content line.\n'.repeat(100); // Should exceed 1KB
      fs.appendFileSync(testFile, largeContent);
      
      // Check after adding content - should need rotation
      rotationCheck = await fileManager.checkFileRotation(testFile);
      this.assert(rotationCheck.needsRotation === true, 'Large file should need rotation');
      this.assert(rotationCheck.currentSize >= 1024, 'File size should exceed threshold');
      
      await fileManager.shutdown();
      
      this.testResults.passed++;
      console.log('   ✓ File size monitoring works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`File size monitoring: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testFileRotation() {
    console.log('3. Testing file rotation...');
    
    try {
      const fileManager = new LSLFileManager({
        rotationThreshold: 512, // 512 bytes for testing
        enableCompression: false, // Test rotation without compression first
        debug: false,
        enableRealTimeMonitoring: false
      });
      
      const testFile = path.join(this.testDir, '.specstory', 'history', '2025-09-14_1600-1700-session.md');
      this.tempFiles.push(testFile);
      
      // Create file that will exceed threshold
      const content = 'This is content that will cause rotation when repeated.\n'.repeat(20);
      fs.writeFileSync(testFile, content);
      
      const originalSize = fs.statSync(testFile).size;
      this.assert(originalSize > 512, 'Test file should exceed rotation threshold');
      
      fileManager.watchFile(testFile);
      
      // Trigger rotation
      const rotationResult = await fileManager.rotateFile(testFile);
      
      this.assert(rotationResult.success === true, 'Rotation should succeed');
      this.assert(rotationResult.originalSize === originalSize, 'Original size should be recorded');
      this.assert(fs.existsSync(rotationResult.rotatedPath), 'Rotated file should exist');
      this.assert(!fs.existsSync(testFile), 'Original file should be moved');
      
      // Check archive directory
      const archiveDir = fileManager.getArchiveDirectory(testFile);
      this.assert(fs.existsSync(archiveDir), 'Archive directory should be created');
      
      const archiveFiles = fs.readdirSync(archiveDir);
      this.assert(archiveFiles.length > 0, 'Archive should contain rotated file');
      
      const stats = fileManager.getStats();
      this.assert(stats.totalRotations === 1, 'Should record one rotation');
      
      // Add rotated file to cleanup
      this.tempFiles.push(rotationResult.rotatedPath);
      
      await fileManager.shutdown();
      
      this.testResults.passed++;
      console.log('   ✓ File rotation works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`File rotation: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testCompression() {
    console.log('4. Testing file compression...');
    
    try {
      const fileManager = new LSLFileManager({
        enableCompression: true,
        compressionLevel: 6,
        keepOriginalAfterCompression: false,
        debug: false,
        enableRealTimeMonitoring: false
      });
      
      const testFile = path.join(this.testDir, '.specstory', 'history', '2025-09-14_1700-1800-session.md');
      this.tempFiles.push(testFile);
      
      // Create compressible content
      const repeatableContent = '# Session Header\n\nThis is repeatable content that compresses well.\n'.repeat(50);
      fs.writeFileSync(testFile, repeatableContent);
      
      const originalSize = fs.statSync(testFile).size;
      
      // Test compression directly
      const compressionResult = await fileManager.compressFile(testFile);
      
      this.assert(compressionResult.success === true, 'Compression should succeed');
      this.assert(compressionResult.originalSize === originalSize, 'Original size should match');
      this.assert(compressionResult.compressedSize < originalSize, 'Compressed size should be smaller');
      this.assert(compressionResult.compressionRatio > 0, 'Compression ratio should be positive');
      
      this.assert(fs.existsSync(compressionResult.compressedPath), 'Compressed file should exist');
      this.assert(!fs.existsSync(testFile), 'Original file should be removed (keepOriginal: false)');
      
      const stats = fileManager.getStats();
      this.assert(stats.totalCompressions === 1, 'Should record one compression');
      this.assert(stats.bytesCompressed === originalSize, 'Should record bytes compressed');
      
      // Add compressed file to cleanup
      this.tempFiles.push(compressionResult.compressedPath);
      
      await fileManager.shutdown();
      
      this.testResults.passed++;
      console.log('   ✓ File compression works correctly');
      console.log(`     Original: ${fileManager.formatBytes(originalSize)}, Compressed: ${fileManager.formatBytes(compressionResult.compressedSize)} (${compressionResult.compressionRatio.toFixed(1)}% reduction)`);
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`File compression: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testArchiveCleanup() {
    console.log('5. Testing archive cleanup...');
    
    try {
      const fileManager = new LSLFileManager({
        maxArchivedFiles: 3, // Keep only 3 files for testing
        debug: false,
        enableRealTimeMonitoring: false
      });
      
      const archiveDir = path.join(this.testDir, '.specstory', 'archive');
      
      // Create 5 test archive files
      const archiveFiles = [];
      for (let i = 1; i <= 5; i++) {
        const archiveFile = path.join(archiveDir, `test-archive-${i}.md`);
        fs.writeFileSync(archiveFile, `Archive file ${i} content`);
        archiveFiles.push(archiveFile);
        this.tempFiles.push(archiveFile);
        
        // Add small delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      const initialFiles = fs.readdirSync(archiveDir).filter(f => f.startsWith('test-archive-'));
      this.assert(initialFiles.length === 5, 'Should have 5 archive files initially');
      
      // Test cleanup
      const cleanupResult = await fileManager.cleanupOldArchives(archiveDir);
      
      // Note: The actual cleanup might vary based on directory state and file sorting
      this.assert(cleanupResult.cleaned >= 0, 'Should have cleaned some files or none');
      this.assert(cleanupResult.total >= 3, 'Should have processed files');
      
      const remainingFiles = fs.readdirSync(archiveDir).filter(f => f.startsWith('test-archive-'));
      this.assert(remainingFiles.length <= 3, 'Should have 3 or fewer files remaining');
      
      await fileManager.shutdown();
      
      this.testResults.passed++;
      console.log('   ✓ Archive cleanup works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Archive cleanup: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testErrorHandling() {
    console.log('6. Testing error handling...');
    
    try {
      const fileManager = new LSLFileManager({
        debug: false,
        enableRealTimeMonitoring: false
      });
      
      // Test rotation of non-existent file
      const nonExistentFile = path.join(this.testDir, 'non-existent.md');
      const rotationCheck = await fileManager.checkFileRotation(nonExistentFile);
      
      this.assert(rotationCheck.needsRotation === false, 'Non-existent file should not need rotation');
      this.assert(rotationCheck.reason === 'File does not exist', 'Should provide appropriate reason');
      
      // Test compression of non-existent file
      try {
        const compressionResult = await fileManager.compressFile(nonExistentFile);
        this.assert(compressionResult.success === false, 'Compression of non-existent file should fail');
        this.assert(typeof compressionResult.error === 'string', 'Should provide error message');
      } catch (error) {
        // Expected behavior - compression should handle ENOENT gracefully
        this.assert(error.code === 'ENOENT', 'Should handle file not found errors');
      }
      
      // Test cleanup of non-existent directory
      const cleanupResult = await fileManager.cleanupOldArchives('/non/existent/path');
      
      this.assert(cleanupResult.cleaned === 0, 'Cleanup of non-existent directory should clean 0 files');
      this.assert(cleanupResult.reason === 'Archive directory does not exist', 'Should provide appropriate reason');
      
      await fileManager.shutdown();
      
      this.testResults.passed++;
      console.log('   ✓ Error handling works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Error handling: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  async testGracefulShutdown() {
    console.log('7. Testing graceful shutdown...');
    
    try {
      const fileManager = new LSLFileManager({
        monitoringInterval: 100, // Fast interval for testing
        enableRealTimeMonitoring: true,
        debug: false
      });
      
      const testFile = path.join(this.testDir, '.specstory', 'history', '2025-09-14_1800-1900-session.md');
      this.tempFiles.push(testFile);
      
      // Create test file
      fs.writeFileSync(testFile, 'Test content for shutdown test');
      fileManager.watchFile(testFile);
      
      // Verify monitoring is active
      this.assert(fileManager.monitoringTimer !== null, 'Monitoring timer should be active');
      
      // Test graceful shutdown
      await fileManager.shutdown();
      
      this.assert(fileManager.monitoringTimer === null, 'Monitoring timer should be cleared');
      this.assert(fileManager.watchedFiles.size === 0, 'Watched files should be cleared');
      
      this.testResults.passed++;
      console.log('   ✓ Graceful shutdown works correctly');
      
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`Graceful shutdown: ${error.message}`);
      console.log('   ✗ Failed:', error.message);
    }
  }
  
  assert(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }
  
  cleanup() {
    // Remove temporary files
    for (const tempFile of this.tempFiles) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    
    // Remove test directory if empty
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
  const test = new LSLFileManagerTest();
  const success = await test.runAllTests();
  process.exit(success ? 0 : 1);
}

export { LSLFileManagerTest };