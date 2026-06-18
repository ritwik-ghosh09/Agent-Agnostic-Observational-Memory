/**
 * Git Analysis Utility - Extract insights from git history
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

export class GitAnalyzer {
  constructor(options = {}) {
    this.options = {
      significanceThreshold: options.significanceThreshold || 7,
      maxCommits: options.maxCommits || 50,
      repoPath: options.repoPath || process.cwd(),
      ...options
    };
  }

  /**
   * Analyze recent commits for insights
   */
  async analyzeRecentCommits(numCommits = 10) {
    try {
      const commits = await this.getRecentCommits(numCommits);
      const insights = [];

      for (const commit of commits) {
        const analysis = await this.analyzeCommit(commit);
        if (analysis.significance >= this.options.significanceThreshold) {
          insights.push(analysis);
        }
      }

      return insights;
    } catch (error) {
      throw new Error(`Failed to analyze recent commits: ${error.message}`);
    }
  }

  /**
   * Get recent git commits
   */
  async getRecentCommits(numCommits = 10) {
    const cmd = `git log --oneline -${numCommits} --pretty=format:'%h|%an|%ad|%s' --date=iso`;
    const { stdout } = await execAsync(cmd, { cwd: this.options.repoPath });
    
    return stdout.split('\n').filter(line => line.length > 0).map(line => {
      const [hash, author, date, message] = line.split('|');
      return { hash, author, date, message };
    });
  }

  /**
   * Analyze a single commit for insights
   */
  async analyzeCommit(commit) {
    try {
      const { hash, author, date, message } = commit;
      
      // Get changed files and diff stats
      const changedFiles = await this.getChangedFiles(hash);
      const diffStats = await this.getDiffStats(hash);
      
      // Analyze commit message for patterns
      const messageAnalysis = this.analyzeCommitMessage(message);
      
      // Calculate significance based on various factors
      const significance = this.calculateCommitSignificance({
        message,
        changedFiles,
        diffStats,
        messageAnalysis
      });

      return {
        hash,
        author,
        date,
        message,
        changedFiles,
        diffStats,
        messageAnalysis,
        significance,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        hash: commit.hash,
        error: error.message,
        significance: 0
      };
    }
  }

  /**
   * Get files changed in a commit
   */
  async getChangedFiles(hash) {
    try {
      const cmd = `git show --name-only --pretty=format: ${hash}`;
      const { stdout } = await execAsync(cmd, { cwd: this.options.repoPath });
      return stdout.split('\n').filter(line => line.trim().length > 0);
    } catch (error) {
      return [];
    }
  }

  /**
   * Get diff statistics for a commit
   */
  async getDiffStats(hash) {
    try {
      const cmd = `git show --stat --pretty=format: ${hash}`;
      const { stdout } = await execAsync(cmd, { cwd: this.options.repoPath });
      const lines = stdout.split('\n').filter(line => line.trim().length > 0);
      const lastLine = lines[lines.length - 1];
      
      if (lastLine && lastLine.includes('changed')) {
        const match = lastLine.match(/(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/);
        if (match) {
          return {
            files: parseInt(match[1]) || 0,
            insertions: parseInt(match[2]) || 0,
            deletions: parseInt(match[3]) || 0
          };
        }
      }
      
      return { files: 0, insertions: 0, deletions: 0 };
    } catch (error) {
      return { files: 0, insertions: 0, deletions: 0 };
    }
  }

  /**
   * Analyze commit message for patterns
   */
  analyzeCommitMessage(message) {
    const patterns = {
      feat: /^feat[(:]/i,
      fix: /^fix[(:]/i,
      refactor: /^refactor[(:]/i,
      docs: /^docs[(:]/i,
      test: /^test[(:]/i,
      chore: /^chore[(:]/i,
      breaking: /BREAKING CHANGE/i,
      architecture: /arch|structure|design|pattern/i,
      performance: /perf|performance|optimize|speed/i,
      security: /security|secure|auth|vulnerability/i,
      api: /api|endpoint|interface/i,
      database: /db|database|migration|schema/i,
      config: /config|configuration|settings/i
    };

    const matched = {};
    for (const [key, pattern] of Object.entries(patterns)) {
      matched[key] = pattern.test(message);
    }

    return matched;
  }

  /**
   * Calculate commit significance based on various factors
   */
  calculateCommitSignificance({ message, changedFiles, diffStats, messageAnalysis }) {
    let significance = 5; // Base significance

    // Increase significance for certain patterns
    if (messageAnalysis.feat) significance += 2;
    if (messageAnalysis.breaking) significance += 3;
    if (messageAnalysis.architecture) significance += 2;
    if (messageAnalysis.performance) significance += 1;
    if (messageAnalysis.security) significance += 2;

    // Adjust based on scope of changes
    if (diffStats.files > 10) significance += 1;
    if (diffStats.files > 20) significance += 1;
    if (diffStats.insertions + diffStats.deletions > 500) significance += 1;

    // Key file changes
    const keyFiles = changedFiles.filter(file => 
      file.includes('package.json') ||
      file.includes('Dockerfile') ||
      file.includes('config') ||
      file.includes('schema') ||
      file.includes('.md') ||
      file.includes('README')
    );
    if (keyFiles.length > 0) significance += 1;

    return Math.min(10, Math.max(1, significance));
  }

  /**
   * Analyze full git history
   */
  async analyzeFullHistory(branch = 'main') {
    try {
      const cmd = `git log ${branch} --oneline --pretty=format:'%h|%an|%ad|%s' --date=iso`;
      const { stdout } = await execAsync(cmd, { cwd: this.options.repoPath });
      
      const commits = stdout.split('\n').filter(line => line.length > 0).map(line => {
        const [hash, author, date, message] = line.split('|');
        return { hash, author, date, message };
      });

      // Sample commits for analysis (don't analyze all commits, just significant ones)
      const significantCommits = commits.filter((_, index) => 
        index % Math.max(1, Math.floor(commits.length / 50)) === 0
      );

      const insights = [];
      for (const commit of significantCommits) {
        const analysis = await this.analyzeCommit(commit);
        if (analysis.significance >= this.options.significanceThreshold) {
          insights.push(analysis);
        }
      }

      return {
        totalCommits: commits.length,
        analyzedCommits: significantCommits.length,
        insights: insights,
        branch: branch
      };
    } catch (error) {
      throw new Error(`Failed to analyze full history: ${error.message}`);
    }
  }

  /**
   * Get repository statistics
   */
  async getRepoStats() {
    try {
      const commands = {
        totalCommits: 'git rev-list --all --count',
        branches: 'git branch -r --format="%(refname:short)"',
        contributors: 'git shortlog -sn --all',
        firstCommit: 'git log --reverse --pretty=format:"%h|%an|%ad|%s" --date=iso | head -1',
        lastCommit: 'git log -1 --pretty=format:"%h|%an|%ad|%s" --date=iso'
      };

      const results = {};
      for (const [key, cmd] of Object.entries(commands)) {
        try {
          const { stdout } = await execAsync(cmd, { cwd: this.options.repoPath });
          results[key] = stdout.trim();
        } catch (error) {
          results[key] = `Error: ${error.message}`;
        }
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to get repository statistics: ${error.message}`);
    }
  }

  /**
   * Generate insights from analysis
   */
  generateInsights(analysisResults) {
    const insights = [];

    // Extract patterns from commit messages
    const messagePatterns = {};
    analysisResults.forEach(result => {
      if (result.messageAnalysis) {
        Object.entries(result.messageAnalysis).forEach(([pattern, matched]) => {
          if (matched) {
            messagePatterns[pattern] = (messagePatterns[pattern] || 0) + 1;
          }
        });
      }
    });

    // Generate pattern insights
    Object.entries(messagePatterns)
      .filter(([pattern, count]) => count > 2)
      .forEach(([pattern, count]) => {
        insights.push({
          type: 'pattern',
          pattern: pattern,
          frequency: count,
          significance: Math.min(10, Math.max(5, Math.floor(count / 2))),
          description: `${pattern} pattern appears ${count} times in recent commits`
        });
      });

    return insights;
  }
}

export default GitAnalyzer;