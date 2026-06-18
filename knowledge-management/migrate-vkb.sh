#!/bin/bash
#
# VKB Migration Script
# Migrates from the old bash-based vkb to the new Node.js implementation
#

set -euo pipefail

echo "VKB Migration Script"
echo "==================="
echo
echo "This script will help migrate from the old vkb to the new Node.js-based implementation."
echo

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check if old vkb is running
echo "1. Checking for existing vkb server..."
if ./vkb status 2>/dev/null | grep -q "running"; then
    echo -e "${YELLOW}Old vkb server is running. Stopping it...${NC}"
    ./vkb stop
    sleep 2
else
    echo -e "${GREEN}No existing vkb server running${NC}"
fi

# Backup old vkb script
echo -e "\n2. Backing up old vkb script..."
if [[ -f "vkb" ]] && [[ ! -f "vkb.backup" ]]; then
    cp vkb vkb.backup
    echo -e "${GREEN}Created backup: vkb.backup${NC}"
else
    echo -e "${YELLOW}Backup already exists or vkb not found${NC}"
fi

# Replace vkb with new version
echo -e "\n3. Replacing vkb with new implementation..."
if cp vkb-new vkb; then
    echo -e "${GREEN}Successfully replaced vkb${NC}"
else
    echo -e "${RED}Failed to replace vkb${NC}"
    exit 1
fi

# Test new implementation
echo -e "\n4. Testing new implementation..."
echo -n "  - Help command: "
if ./vkb help >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗${NC}"
fi

echo -n "  - Status command: "
if ./vkb status >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗${NC}"
fi

# Show differences
echo -e "\n5. Key differences in the new implementation:"
echo "  - Uses Node.js instead of bash for better cross-platform support"
echo "  - Improved error handling and process management"
echo "  - Browser cache clearing not implemented (use browser refresh instead)"
echo "  - All core functionality preserved"

echo -e "\n${GREEN}Migration complete!${NC}"
echo
echo "You can now use vkb as before. Examples:"
echo "  vkb              # Start the server"
echo "  vkb stop         # Stop the server"
echo "  vkb restart      # Restart the server"
echo "  vkb status       # Check status"
echo "  vkb logs         # View logs"
echo
echo "If you encounter issues, you can restore the old version:"
echo "  cp vkb.backup vkb"