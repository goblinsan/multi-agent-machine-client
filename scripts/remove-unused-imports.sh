#!/bin/bash
# Remove unused imports systematically

# Run lint and save output
npm run lint 2>&1 > /tmp/lint-full.txt

# Extract file:line:col for each unused import warning
grep "is defined but never used" /tmp/lint-full.txt | \
  grep -E "(logger|cfg|randomUUID|slugify|firstString)" | \
  while IFS= read -r line; do
    echo "Found: $line"
  done

echo ""
echo "Warnings reduced: $(grep -c "is defined but never used" /tmp/lint-full.txt) remaining"
echo "Total warnings: $(grep "✖.*problems" /tmp/lint-full.txt | grep -oE "[0-9]+ warnings" | grep -oE "[0-9]+")"
