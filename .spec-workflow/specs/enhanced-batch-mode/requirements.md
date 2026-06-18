# Requirements Document

## Introduction

The Enhanced Batch Mode system is a critical stabilization and debugging improvement to the existing Live Session Logging (LSL) infrastructure. This is NOT a redesign but rather a focused fix to address the current fundamental flaw where foreign mode generates files without proper content classification, resulting in 0 classification hits and incorrect file generation.

The primary purpose is to analyze, debug, and fix the existing classification-driven batch processing to ensure it can distinguish coding-related activities (= related to the content and focus of project "coding", currently checked out at ~/Agentic/coding - on this machine) from general conversation across multiple projects, ensuring that only relevant exchanges are included in foreign session files (which means files written TO the coding project FROM other projects).

**Key Clarification**: "Foreign" mode means generating files IN the coding project that contain coding-related content extracted FROM other projects (like nano-degree). Foreign files are always written TO the coding project.

## Alignment with Product Vision

This feature directly supports the coding project's core mission of providing intelligent, automated session logging and knowledge management. It aligns with the goal of stabilizing and de-cluttering the existing classification system to accurately route and organize development-related content across multiple project contexts.

## Requirements

### Requirement 1: Analyze Existing System Before Fixing

**User Story:** As a developer debugging the batch mode system, I want a thorough analysis of the existing codebase using the ingest MCP server, so that fixes are based on understanding current implementation rather than assumptions.

#### Acceptance Criteria

1. WHEN starting the fix process THEN the system SHALL analyze ~/Agentic/coding using the ingest MCP server to understand existing architecture
2. IF existing code patterns are identified THEN fixes SHALL build upon them rather than replacing them
3. WHEN analysis is complete THEN a clear understanding of the current classification pipeline SHALL be documented

### Requirement 2: Fix Classification Integration (Not Redesign)

**User Story:** As a developer working across multiple projects, I want the existing batch mode system fixed to accurately identify and extract only coding-related exchanges from other projects, so that foreign session files contain relevant development activities without noise.

#### Acceptance Criteria

1. WHEN running foreign mode batch processing THEN the existing ReliableCodingClassifier SHALL be properly invoked to evaluate each exchange
2. IF an exchange is classified as coding-related THEN the system SHALL include it in the foreign session file written TO the coding project
3. WHEN foreign mode processing completes THEN classification statistics SHALL show actual classifier usage (>0 hits for coding content)
4. IF classification fails THEN the system SHALL throw meaningful error messages rather than masking failures with fallbacks

### Requirement 3: Stabilize Three Batch Modes (Existing Architecture)

**User Story:** As a developer managing LSL files, I want the existing three distinct batch modes (all, local, foreign) stabilized with proper filtering logic, so that I can regenerate exactly the content I need.

#### Acceptance Criteria

1. WHEN using --mode=all THEN the existing system SHALL generate both local and foreign session files correctly
2. WHEN using --mode=local THEN the existing system SHALL generate only local project session files
3. WHEN using --mode=foreign THEN the existing system SHALL generate only foreign session files (TO coding project) with fixed classification-based filtering

### Requirement 4: Add Comprehensive Logging for Debugging

**User Story:** As a developer debugging batch processing failures, I want comprehensive logging output written to log files, so that I can trace operations when things fail.

#### Acceptance Criteria

1. WHEN batch processing runs THEN all classification decisions SHALL be logged to traceable log files
2. IF errors occur THEN detailed error context SHALL be written to logs with timestamps and operation details
3. WHEN foreign mode processes exchanges THEN each classification result SHALL be logged for debugging
4. IF classification fails THEN error logs SHALL contain enough information to reproduce and fix the issue

### Requirement 5: Fix Environment Configuration (Existing System)

**User Story:** As a developer running batch processing from any project, I want the existing environment configuration handling fixed, so that classification works correctly regardless of execution context.

#### Acceptance Criteria

1. WHEN TRANSCRIPT_SOURCE_PROJECT points to the coding project THEN existing classification SHALL work correctly
2. IF batch processing runs from non-coding project THEN existing environment variables SHALL be configured properly
3. WHEN foreign mode executes THEN output files SHALL be written to the correct coding project directory using existing path logic

### Requirement 6: Error Handling Without Fallbacks

**User Story:** As a developer debugging batch processing issues, I want meaningful error messages when things fail, so that I can identify and fix root causes rather than dealing with masked failures.

#### Acceptance Criteria

1. WHEN classification fails THEN the system SHALL throw descriptive error messages rather than continuing with fallbacks
2. IF ReliableCodingClassifier initialization fails THEN the system SHALL stop with clear error information
3. WHEN environment configuration is incorrect THEN the system SHALL provide actionable error messages

### Requirement 7: Performance Monitoring (Fix Existing)

**User Story:** As a developer monitoring batch processing performance, I want the existing classification metrics fixed to show accurate timing data, so that I can verify the system is working correctly.

#### Acceptance Criteria

1. WHEN batch processing completes THEN existing classification statistics SHALL show actual hit counts for each layer
2. IF ReliableCodingClassifier is used THEN existing timing metrics SHALL be reported accurately
3. WHEN no coding content is found THEN existing statistics SHALL clearly indicate 0 legitimate hits rather than system failure

## Non-Functional Requirements

### Code Architecture and Modularity
- **Preserve Existing Architecture**: Build upon existing patterns rather than redesigning
- **Fix Classification Integration**: Ensure existing ReliableCodingClassifier is properly invoked
- **Maintain Existing Interfaces**: Work within current component boundaries
- **Stabilize Existing Logic**: Debug and fix current implementation rather than replacing

### Performance
- **Use Existing Targets**: Maintain existing <10ms per exchange classification target
- **Fix Existing Bottlenecks**: Identify and resolve current performance issues
- **Stable Memory Usage**: Fix any memory leaks in existing batch operations

### Security
- **Preserve Existing Security**: Maintain current API key redaction functionality
- **Fix Secret Handling**: Ensure existing secret handling works correctly in batch mode

### Reliability
- **No Fallback Masking**: Remove any fallbacks that hide classification failures
- **Meaningful Error Messages**: Replace silent failures with descriptive errors
- **Comprehensive Logging**: Add logging to trace all operations for debugging
- **Accurate Statistics**: Fix existing metrics to reflect actual system behavior

### Usability
- **Improve Existing CLI**: Enhance current command line interface feedback
- **Better Error Messages**: Make existing error reporting more actionable and specific
- **Maintain Existing Usage**: Keep current processing mode interface intuitive