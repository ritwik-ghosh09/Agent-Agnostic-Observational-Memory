# Tasks Document

<!-- AI Instructions: For each task, generate a _Prompt field with structured AI guidance following this format:
_Prompt: Role: [specialized developer role] | Task: [clear task description with context references] | Restrictions: [what not to do, constraints] | Success: [specific completion criteria]_
This helps provide better AI agent guidance beyond simple "work on this task" prompts. -->

- [x] 1. Fix Environment Configuration in Batch Processing Script
  - File: scripts/generate-proper-lsl-from-transcripts.js
  - Fix getTargetProject() function to properly handle TRANSCRIPT_SOURCE_PROJECT environment variable
  - Ensure classification works correctly regardless of execution context
  - Purpose: Correct environment variable handling for proper classification initialization
  - _Leverage: Existing getTargetProject() function, environment variable patterns_
  - _Requirements: 4.1, 4.2, 4.3_
  - _Prompt: Role: DevOps Engineer specializing in environment configuration and Node.js scripts | Task: Fix getTargetProject() function in scripts/generate-proper-lsl-from-transcripts.js to properly handle TRANSCRIPT_SOURCE_PROJECT environment variable following requirements 4.1-4.3, ensuring classification works correctly when run from any project context | Restrictions: Do not modify existing project detection logic unnecessarily, maintain backward compatibility with current usage, do not change filename patterns | Success: TRANSCRIPT_SOURCE_PROJECT correctly points to coding project during classification, batch processing works from both coding and non-coding projects, environment variables are validated with meaningful error messages_

- [x] 2. Add Classification Calls to Exchange Processing Loop
  - File: scripts/generate-proper-lsl-from-transcripts.js
  - Insert monitor.reliableCodingClassifier.classify() calls in foreign mode exchange processing
  - Add classification result filtering logic for foreign file inclusion
  - Purpose: Fix the core issue where classification is never called during batch processing
  - _Leverage: Existing exchange processing loop, initialized EnhancedTranscriptMonitor, ReliableCodingClassifier interface_
  - _Requirements: 2.1, 2.2, 2.3_
  - _Prompt: Role: Backend Developer specializing in Node.js and content classification systems | Task: Insert classification calls into the existing exchange processing loop following requirements 2.1-2.3, using the already initialized monitor.reliableCodingClassifier.classify() method to filter exchanges for foreign mode | Restrictions: Do not modify the existing exchange parsing logic, maintain compatibility with current session file formats, only add classification for foreign mode | Success: Foreign mode actually calls classification for each exchange, only coding-related exchanges are included in foreign files, classification statistics show >0 hits when processing coding content_

- [x] 3. Add Comprehensive Classification Logging
  - File: scripts/generate-proper-lsl-from-transcripts.js
  - Add debug logging for each classification decision with exchange content
  - Log classification results, timing, and layer information to .specstory/logs/
  - Purpose: Enable debugging of classification decisions and performance tracking
  - _Leverage: Existing logging patterns, .specstory directory structure, console.log patterns_
  - _Requirements: 4.1, 4.2_
  - _Prompt: Role: DevOps Engineer with expertise in application logging and debugging | Task: Add comprehensive classification logging following requirements 4.1-4.2, creating debug logs for each classification decision with exchange content, results, and timing information in .specstory/logs/ | Restrictions: Do not log sensitive information or API keys, maintain log file size reasonable, use existing secret redaction functions | Success: Each classification decision is logged with sufficient detail for debugging, log files are created in appropriate directory, logs include timing and layer information for performance analysis_

- [x] 4. Enhance Error Handling and Remove Fallback Masking
  - File: scripts/generate-proper-lsl-from-transcripts.js
  - Replace silent classification failures with descriptive error throwing
  - Add validation for ReliableCodingClassifier initialization
  - Purpose: Provide meaningful error messages instead of masking classification failures
  - _Leverage: Existing error handling patterns, console error output_
  - _Requirements: 6.1, 6.2, 6.3_
  - _Prompt: Role: Quality Assurance Engineer specializing in error handling and system reliability | Task: Replace silent classification failures with descriptive error throwing following requirements 6.1-6.3, adding proper validation for ReliableCodingClassifier initialization | Restrictions: Do not break existing error handling for non-classification errors, maintain script execution flow for valid scenarios, provide actionable error messages | Success: Classification failures throw descriptive errors with context, ReliableCodingClassifier initialization failures are clearly reported, error messages provide actionable guidance for resolution_

- [x] 5. Fix Classification Statistics Reporting
  - File: scripts/generate-proper-lsl-from-transcripts.js
  - Ensure classification performance metrics accurately reflect actual usage
  - Add foreign mode specific statistics (inclusion rate, classification breakdown)
  - Purpose: Provide accurate performance monitoring and debugging information
  - _Leverage: Existing monitor.reliableCodingClassifier.getStats() method, console output patterns_
  - _Requirements: 7.1, 7.2_
  - _Prompt: Role: Performance Engineer with expertise in metrics collection and reporting | Task: Fix classification statistics reporting following requirements 7.1-7.2, ensuring performance metrics accurately reflect actual classifier usage and adding foreign mode specific statistics | Restrictions: Do not modify existing stats structure from ReliableCodingClassifier, maintain compatibility with current output format, only add new metrics | Success: Classification statistics show actual hit counts when classifier is used, foreign mode statistics include inclusion rate and classification breakdown, performance metrics accurately reflect system behavior_

- [x] 6. Update Command Line Interface and Documentation
  - File: scripts/generate-proper-lsl-from-transcripts.js
  - Enhance help text and error messages for improved usability
  - Add validation for command line arguments
  - Purpose: Improve user experience and prevent configuration errors
  - _Leverage: Existing argument parsing, help text patterns_
  - _Requirements: 5.1, 5.2, 5.3_
  - _Prompt: Role: Technical Writer and UX Engineer specializing in command line interfaces | Task: Enhance command line interface following requirements 5.1-5.3, improving help text, error messages, and argument validation for better usability | Restrictions: Do not change existing argument names or behavior, maintain backward compatibility, keep help text concise but informative | Success: Command line interface provides clear usage guidance, argument validation prevents common errors, error messages are actionable and specific_

- [x] 7. Create Comprehensive Test Suite for Batch Processing
  - File: test/batch-processing/enhanced-batch-mode.test.js (new file)
  - Write tests for all three modes (all, local, foreign) with real transcript data
  - Test classification integration and error handling scenarios
  - Purpose: Ensure reliability and prevent regressions in batch processing functionality
  - _Leverage: Existing test patterns, test transcript data, jest/mocha framework_
  - _Requirements: All requirements_
  - _Prompt: Role: QA Automation Engineer with expertise in Node.js testing and integration testing | Task: Create comprehensive test suite covering all requirements, testing all three batch modes with real transcript data and classification integration scenarios | Restrictions: Must test actual classification behavior not just mocks, use real but non-sensitive transcript data, ensure tests are reliable and maintainable | Success: All three batch modes are thoroughly tested, classification integration is validated, error scenarios are covered, tests run reliably in CI environment_

- [x] 8. Validate Cross-Project Execution Scenarios
  - File: scripts/generate-proper-lsl-from-transcripts.js (validation testing)
  - Test foreign mode execution from nano-degree and other projects
  - Verify correct file routing and environment variable handling
  - Purpose: Ensure the system works correctly across different project contexts
  - _Leverage: Existing project structure, environment variable patterns_
  - _Requirements: 3.1, 3.2, 4.2_
  - _Prompt: Role: Integration Engineer with expertise in cross-project workflows and environment management | Task: Validate cross-project execution scenarios following requirements 3.1, 3.2, and 4.2, testing foreign mode execution from different projects with proper file routing | Restrictions: Do not modify project structures, test with actual project directories, ensure no interference with existing workflows | Success: Foreign mode works correctly when executed from any project, files are properly routed to coding project, environment variables are configured correctly across execution contexts_

- [x] 9. Performance Optimization and Memory Management
  - File: scripts/generate-proper-lsl-from-transcripts.js
  - Optimize classification calls to maintain <10ms per exchange target
  - Add memory management for large transcript datasets
  - Purpose: Ensure batch processing performance meets established targets
  - _Leverage: Existing ReliableCodingClassifier performance optimizations, memory management patterns_
  - _Requirements: Performance requirements from design_
  - _Prompt: Role: Performance Engineer specializing in Node.js optimization and memory management | Task: Optimize classification performance to maintain <10ms per exchange target and implement memory management for large datasets, leveraging existing ReliableCodingClassifier optimizations | Restrictions: Do not compromise classification accuracy for performance, maintain compatibility with existing performance monitoring, avoid memory leaks | Success: Classification performance meets <10ms target per exchange, memory usage remains stable during large batch operations, no performance regressions in existing functionality_

- [x] 10. Final Integration Testing and Documentation Update
  - File: Multiple files (scripts/, docs/, test/)
  - Perform end-to-end testing of all enhanced batch mode functionality
  - Update documentation to reflect classification integration improvements
  - Purpose: Ensure complete system integration and provide updated usage guidance
  - _Leverage: Existing documentation patterns, test frameworks, README structure_
  - _Requirements: All requirements_
  - _Prompt: Role: Technical Lead with expertise in system integration and technical documentation | Task: Complete final integration testing and documentation updates covering all requirements, ensuring enhanced batch mode functionality is fully integrated and documented | Restrictions: Do not break existing functionality, maintain documentation consistency with existing patterns, ensure all changes are properly documented | Success: All enhanced batch mode features work together correctly, classification integration is seamless, documentation accurately reflects new functionality and provides clear usage guidance_