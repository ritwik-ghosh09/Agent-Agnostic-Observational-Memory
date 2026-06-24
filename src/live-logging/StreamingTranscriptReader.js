/**
 * StreamingTranscriptReader - Memory-efficient streaming reader for JSONL transcript files
 * 
 * Features:
 * - Streaming line-by-line processing
 * - Configurable batch size
 * - Memory usage tracking
 * - Progress reporting
 * - Error recovery
 */

import fs from 'fs';
import readline from 'readline';
import { EventEmitter } from 'events';
import AdaptiveExchangeExtractor from './AdaptiveExchangeExtractor.js';

class StreamingTranscriptReader extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      batchSize: options.batchSize || 10,  // Small batch for memory efficiency
      maxMemoryMB: options.maxMemoryMB || 200,  // Max memory usage in MB - increased for large files
      progressInterval: options.progressInterval || 100,  // Report progress every N lines
      errorRecovery: options.errorRecovery !== false,  // Continue on parse errors
      debug: options.debug || false,
      useAdaptiveExtraction: options.useAdaptiveExtraction !== false  // Enable adaptive extraction by default
    };
    
    this.stats = {
      linesRead: 0,
      linesProcessed: 0,
      errors: 0,
      batches: 0,
      memoryUsed: 0,
      startTime: null,
      endTime: null
    };
    
    this.currentBatch = [];
  }

  /**
   * Stream process a transcript file with memory-efficient batching
   */
  async processFile(filePath, processor) {
    return new Promise((resolve, reject) => {
      this.stats.startTime = Date.now();
      this.stats.linesRead = 0;
      this.stats.linesProcessed = 0;
      this.stats.errors = 0;
      this.stats.batches = 0;
      
      // Check file exists
      if (!fs.existsSync(filePath)) {
        return reject(new Error(`File not found: ${filePath}`));
      }
      
      const fileSize = fs.statSync(filePath).size;
      const fileStream = fs.createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity  // Handle both \n and \r\n
      });
      
      let bytesRead = 0;
      let lastProgressReport = 0;
      
      // Process each line
      rl.on('line', async (line) => {
        this.stats.linesRead++;
        bytesRead += Buffer.byteLength(line, 'utf8');
        
        // Skip empty lines
        if (!line.trim()) return;
        
        try {
          // Parse JSON line
          const message = JSON.parse(line);
          this.currentBatch.push(message);
          
          // Process batch when full
          if (this.currentBatch.length >= this.config.batchSize) {
            rl.pause();  // Pause reading while processing
            await this.processBatch(processor);
            rl.resume();  // Resume reading
          }
          
          // Report progress
          if (this.stats.linesRead - lastProgressReport >= this.config.progressInterval) {
            lastProgressReport = this.stats.linesRead;
            const progress = (bytesRead / fileSize) * 100;
            this.emit('progress', {
              linesRead: this.stats.linesRead,
              linesProcessed: this.stats.linesProcessed,
              progress: progress.toFixed(1),
              memoryMB: this.getMemoryUsageMB()
            });
          }
          
          // Check memory usage
          if (this.getMemoryUsageMB() > this.config.maxMemoryMB) {
            this.debug(`Memory limit reached (${this.getMemoryUsageMB()}MB), processing batch`);
            rl.pause();
            await this.processBatch(processor);
            
            // Force garbage collection if available
            if (global.gc) {
              global.gc();
            }
            
            rl.resume();
          }
          
        } catch (error) {
          this.stats.errors++;
          this.emit('error', {
            line: this.stats.linesRead,
            error: error.message,
            content: line.substring(0, 100) + '...'
          });
          
          if (!this.config.errorRecovery) {
            rl.close();
            reject(error);
          }
        }
      });
      
      // Handle end of file
      rl.on('close', async () => {
        // Process remaining batch
        if (this.currentBatch.length > 0) {
          await this.processBatch(processor);
        }
        
        this.stats.endTime = Date.now();
        const duration = (this.stats.endTime - this.stats.startTime) / 1000;
        
        this.emit('complete', {
          ...this.stats,
          duration: duration,
          throughput: (this.stats.linesProcessed / duration).toFixed(1)
        });
        
        resolve(this.stats);
      });
      
      // Handle stream errors
      fileStream.on('error', (error) => {
        this.emit('error', {
          type: 'stream',
          error: error.message
        });
        reject(error);
      });
    });
  }

  /**
   * Process a batch of messages
   */
  async processBatch(processor) {
    if (this.currentBatch.length === 0) return;
    
    const batch = [...this.currentBatch];
    this.currentBatch = [];  // Clear batch immediately to free memory
    this.stats.batches++;
    
    try {
      // Call the processor with the batch
      await processor(batch);
      this.stats.linesProcessed += batch.length;
      
      this.emit('batch', {
        batchNumber: this.stats.batches,
        batchSize: batch.length,
        totalProcessed: this.stats.linesProcessed
      });
      
    } catch (error) {
      this.emit('error', {
        type: 'processing',
        batch: this.stats.batches,
        error: error.message
      });
      
      if (!this.config.errorRecovery) {
        throw error;
      }
    }
  }

  /**
   * Get current memory usage in MB
   */
  getMemoryUsageMB() {
    const usage = process.memoryUsage();
    return Math.round(usage.heapUsed / 1024 / 1024);
  }

  /**
   * Extract exchanges from a batch of messages with adaptive format detection
   * Automatically handles any transcript format through learning
   */
  static extractExchangesFromBatch(messages, options = {}) {
    console.log(`🚨 DEBUG: StreamingTranscriptReader.extractExchangesFromBatch called with ${messages.length} messages`);
    // Use adaptive extraction by default
    if (options.useAdaptiveExtraction !== false) {
      console.log(`🚨 DEBUG: Using AdaptiveExchangeExtractor for batch processing`);
      return AdaptiveExchangeExtractor.extractExchangesFromBatch(messages, {
        debug: options.debug || false,
        configPath: options.formatConfigPath
      });
    }
    
    // Fallback to manual extraction for backwards compatibility
    return StreamingTranscriptReader.legacyExtractExchangesFromBatch(messages);
  }

  /**
   * Legacy extraction method for backwards compatibility
   * Handles both old format (user/assistant) and new format (human_turn_start/claude_turn_start)
   */
  static legacyExtractExchangesFromBatch(messages) {
    const exchanges = [];
    let currentExchange = null;
    
    for (const msg of messages) {
      // NEW FORMAT: human_turn_start/claude_turn_start
      if (msg.type === 'human_turn_start') {
        // Start new exchange
        currentExchange = {
          uuid: msg.uuid,
          timestamp: msg.timestamp,
          humanMessage: null,
          assistantMessage: null,
          toolCalls: [],
          toolResults: []
        };
      } else if (msg.type === 'human_turn_end' && currentExchange) {
        currentExchange.humanMessage = msg.content;
      } else if (msg.type === 'claude_turn_start' && currentExchange) {
        // Assistant message will be added at turn end
      } else if (msg.type === 'tool_use' && currentExchange) {
        currentExchange.toolCalls.push({
          id: msg.tool_use_id,
          name: msg.tool_name,
          input: msg.input_json
        });
      } else if (msg.type === 'tool_result' && currentExchange) {
        currentExchange.toolResults.push({
          tool_use_id: msg.tool_use_id,
          output: msg.output_json,
          is_error: msg.is_error || false
        });
      } else if (msg.type === 'claude_turn_end' && currentExchange) {
        currentExchange.assistantMessage = msg.content;
        exchanges.push(currentExchange);
        currentExchange = null;
      }
      
      // OLD FORMAT: user/assistant - handle differently
      else if (msg.type === 'user' && msg.message?.role === 'user') {
        // Complete previous exchange if exists
        if (currentExchange) {
          exchanges.push(currentExchange);
        }
        
        // Extract user message content
        let userContent = '';
        if (msg.message?.content) {
          if (typeof msg.message.content === 'string') {
            userContent = msg.message.content;
          } else if (Array.isArray(msg.message.content)) {
            userContent = msg.message.content
              .filter(item => item.type === 'text')
              .map(item => item.text)
              .join('\n');
          }
        }
        
        // Start new exchange
        currentExchange = {
          uuid: msg.uuid,
          timestamp: msg.timestamp,
          humanMessage: userContent,
          assistantMessage: null,
          toolCalls: [],
          toolResults: [],
          isUserPrompt: true
        };
      } else if (msg.type === 'assistant' && msg.message?.role === 'assistant' && currentExchange) {
        // Extract assistant message content
        let assistantContent = '';
        if (msg.message?.content) {
          if (typeof msg.message.content === 'string') {
            assistantContent = msg.message.content;
          } else if (Array.isArray(msg.message.content)) {
            // Handle tool calls and text content
            for (const item of msg.message.content) {
              if (item.type === 'text') {
                assistantContent += item.text;
              } else if (item.type === 'tool_use') {
                currentExchange.toolCalls.push({
                  id: item.id,
                  name: item.name,
                  input: item.input
                });
              }
            }
          }
        }
        
        currentExchange.assistantMessage = assistantContent;
        exchanges.push(currentExchange);
        currentExchange = null;
      }
    }
    
    // Handle any remaining exchange
    if (currentExchange) {
      exchanges.push(currentExchange);
    }
    
    return exchanges;
  }

  debug(message) {
    if (this.config.debug) {
      console.log(`[StreamingTranscriptReader] ${message}`);
    }
  }
}

export default StreamingTranscriptReader;