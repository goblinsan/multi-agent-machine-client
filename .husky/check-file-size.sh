#!/usr/bin/env bash

# Check file size limits for staged files
# Max lines per file (warn at 400, error at 600)
WARN_THRESHOLD=400
ERROR_THRESHOLD=600

# Get staged TypeScript files
STAGED_TS_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.ts$' | grep -v '\.test\.ts$' | grep -v 'node_modules')

if [ -z "$STAGED_TS_FILES" ]; then
  exit 0
fi

HAS_WARNINGS=0
HAS_ERRORS=0

echo "📏 Checking file sizes..."

for file in $STAGED_TS_FILES; do
  if [ -f "$file" ]; then
    LINES=$(wc -l < "$file")
    
    if [ "$LINES" -ge "$ERROR_THRESHOLD" ]; then
      echo "❌ ERROR: $file has $LINES lines (limit: $ERROR_THRESHOLD)"
      echo "   This file needs to be refactored into smaller modules."
      HAS_ERRORS=1
    elif [ "$LINES" -ge "$WARN_THRESHOLD" ]; then
      echo "⚠️  WARNING: $file has $LINES lines (recommended max: $WARN_THRESHOLD)"
      echo "   Consider refactoring this file soon."
      HAS_WARNINGS=1
    fi
  fi
done

if [ $HAS_ERRORS -eq 1 ]; then
  echo ""
  echo "💡 Refactoring tips:"
  echo "   - Extract large methods into separate files"
  echo "   - Split classes by responsibility (Single Responsibility Principle)"
  echo "   - Create utility modules for helper functions"
  echo "   - Move related logic into dedicated services"
  echo ""
  echo "To bypass this check (not recommended): git commit --no-verify"
  exit 1
fi

if [ $HAS_WARNINGS -eq 1 ]; then
  echo ""
  echo "⚠️  Large files detected. Please address these in future commits."
fi

exit 0
