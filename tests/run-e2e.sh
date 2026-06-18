#!/bin/bash

# E2E Test Runner for Live Session Logging System
# Convenient wrapper script for running E2E tests with different configurations

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_FRAMEWORK="$SCRIPT_DIR/e2e/test-framework.js"

# Default options
PARALLEL=false
VERBOSE=false
KEEP_DATA=false
TIMEOUT=30000
HELP=false

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Run Live Session Logging E2E tests"
    echo ""
    echo "Options:"
    echo "  -p, --parallel      Run tests in parallel (faster but less isolated)"
    echo "  -v, --verbose       Show detailed test output"
    echo "  -k, --keep-data     Keep test data after completion (for debugging)"
    echo "  -t, --timeout=MS    Set test timeout in milliseconds (default: 30000)"
    echo "  -h, --help          Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                  # Run all tests sequentially"
    echo "  $0 -p -v            # Run tests in parallel with verbose output"
    echo "  $0 -k -t 60000      # Keep test data with 60s timeout"
    echo ""
    echo "Test Categories:"
    echo "  • Core Components: UserHashGenerator, ConfigurableRedactor, timezone-utils"
    echo "  • Integration: TranscriptMonitoring, BatchProcessing, MultiUserCoordination"
    echo "  • Deployment: Local, CrossProject, MultiUser scenarios"
    echo "  • Performance: Benchmarks and stress testing"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--parallel)
            PARALLEL=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -k|--keep-data)
            KEEP_DATA=true
            shift
            ;;
        -t|--timeout=*)
            TIMEOUT="${1#*=}"
            shift
            ;;
        -t|--timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        -h|--help)
            HELP=true
            shift
            ;;
        *)
            echo -e "${RED}Error: Unknown option $1${NC}" >&2
            print_usage >&2
            exit 1
            ;;
    esac
done

if [ "$HELP" = true ]; then
    print_usage
    exit 0
fi

# Verify test framework exists
if [ ! -f "$TEST_FRAMEWORK" ]; then
    echo -e "${RED}Error: Test framework not found at $TEST_FRAMEWORK${NC}" >&2
    exit 1
fi

# Build node command with options
NODE_ARGS=()
if [ "$PARALLEL" = true ]; then
    NODE_ARGS+=(--parallel)
fi
if [ "$VERBOSE" = true ]; then
    NODE_ARGS+=(--verbose)
fi
if [ "$KEEP_DATA" = true ]; then
    NODE_ARGS+=(--keep-data)
fi
NODE_ARGS+=(--timeout="$TIMEOUT")

# Print test configuration
echo -e "${BLUE}🧪 Live Session Logging E2E Tests${NC}"
echo -e "${BLUE}=================================${NC}"
echo ""
echo "Configuration:"
echo "  Parallel execution: $PARALLEL"
echo "  Verbose output: $VERBOSE"
echo "  Keep test data: $KEEP_DATA"
echo "  Timeout: ${TIMEOUT}ms"
echo ""

# Run the tests
echo -e "${YELLOW}Starting test execution...${NC}"
echo ""

if node "$TEST_FRAMEWORK" "${NODE_ARGS[@]}"; then
    echo ""
    echo -e "${GREEN}🎉 All E2E tests passed successfully!${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}❌ E2E tests failed. Check output above for details.${NC}"
    
    if [ "$KEEP_DATA" = false ]; then
        echo -e "${YELLOW}💡 Tip: Use -k/--keep-data to preserve test artifacts for debugging${NC}"
    fi
    
    exit 1
fi