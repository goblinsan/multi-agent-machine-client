#!/bin/bash
# Script to consolidate Redis mocks across test files

cd "$(dirname "$0")/.."

# List of files to update
files=(
  "tests/branchSelection.test.ts"
  "tests/commitAndPush.test.ts"
  "tests/coordinator.test.ts"
  "tests/dashboardInteractions.test.ts"
  "tests/handleCoordinator.overrides.test.ts"
  "tests/happyPath.test.ts"
  "tests/initialPlanningAckAndEval.test.ts"
  "tests/planningLoopLogging.test.ts"
  "tests/processedOnce.test.ts"
  "tests/qaFollowupExecutes.test.ts"
  "tests/qaPlanIterationMax.test.ts"
  "tests/qaPmGating.test.ts"
  "tests/tddGovernanceGate.test.ts"
  "tests/workflowAbort.test.ts"
  "tests/workflowCoordinator.test.ts"
)

for file in "${files[@]}"; do
  echo "Processing $file..."
  
  # Check if file already has createRedisMock import
  if grep -q "import.*createRedisMock.*from.*mockHelpers" "$file"; then
    echo "  - Already has createRedisMock import, skipping import addition"
  else
    # Check if file has existing mockHelpers import to extend
    if grep -q "import.*from.*'./helpers/mockHelpers" "$file"; then
      echo "  - Extending existing mockHelpers import"
      # Add createRedisMock to existing import
      sed -i.bak "s/import {/import { createRedisMock, /" "$file"
    else
      echo "  - Adding new createRedisMock import"
      # Add import after first import line
      sed -i.bak "1a\\
import { createRedisMock } from './helpers/mockHelpers.js';
" "$file"
    fi
  fi
  
  # Replace the inline Redis mock with createRedisMock()
  # This is a multi-line replacement, so we'll use a more sophisticated approach
  python3 << 'EOF'
import re
import sys

file_path = sys.argv[1]

with open(file_path, 'r') as f:
    content = f.read()

# Pattern to match the inline Redis mock
pattern = r"vi\.mock\(['\"]\.\.\/src\/redisClient\.js['\"],\s*\(\)\s*=>\s*\(\{[^}]*makeRedis:[^}]*xGroupCreate:[^}]*xReadGroup:[^}]*xAck:[^}]*disconnect:[^}]*quit:[^}]*xRevRange:[^}]*xAdd:[^}]*exists:[^}]*\}\)\s*\}\)\);"

replacement = "vi.mock('../src/redisClient.js', () => createRedisMock());"

# Replace the pattern
new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)

if new_content != content:
    with open(file_path, 'w') as f:
        f.write(new_content)
    print(f"  - Replaced inline Redis mock in {file_path}")
else:
    print(f"  - No replacement made in {file_path}")

EOF
python3 -c "
import re, sys
file_path = '$file'
with open(file_path, 'r') as f:
    content = f.read()
pattern = r\"vi\.mock\(['\\\"]\.\.\/src\/redisClient\.js['\\\"],\s*\(\)\s*=>\s*\(\{[^}]*makeRedis:[^}]*xGroupCreate:[^}]*xReadGroup:[^}]*xAck:[^}]*disconnect:[^}]*quit:[^}]*xRevRange:[^}]*xAdd:[^}]*exists:[^}]*\}\)\s*\}\)\);\"
replacement = \"vi.mock('../src/redisClient.js', () => createRedisMock());\"
new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)
if new_content != content:
    with open(file_path, 'w') as f:
        f.write(new_content)
    print('  - Replaced inline Redis mock')
else:
    print('  - Pattern not found, trying alternative')
" 2>/dev/null || echo "  - Python replacement skipped"

done

# Clean up backup files
rm -f tests/*.bak

echo ""
echo "Consolidation complete!"
echo "Run 'npm test' to verify all tests still pass."
