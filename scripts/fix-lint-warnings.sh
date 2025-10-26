#!/bin/bash
# Fix common ESLint warnings automatically

echo "🔧 Fixing ESLint warnings..."

# Fix @ts-ignore -> @ts-expect-error
echo "📝 Replacing @ts-ignore with @ts-expect-error..."
find src tests -name "*.ts" -type f -exec sed -i '' 's/@ts-ignore/@ts-expect-error/g' {} +

# Fix unnecessary escapes in regex
echo "🔍 Fixing unnecessary regex escapes..."
# Fix \- (not needed in character classes unless at start/end)
find src -name "*.ts" -type f -exec sed -i '' 's/\\\-/-/g' {} +
# Fix \/ (not needed)
find src -name "*.ts" -type f -exec sed -i '' 's/\\\//\//g' {} +
# Fix \" when not needed
find src -name "*.ts" -type f -exec sed -i '' "s/\\\\\"/\"/g" {} +
# Fix \' when not needed  
find src -name "*.ts" -type f -exec sed -i '' "s/\\\\'/'/g" {} +

echo "✅ Auto-fixes complete!"
echo "⚠️  You still need to manually:"
echo "  1. Prefix unused variables with '_' (157 warnings)"
echo "  2. Add comments to empty catch blocks (28 warnings)"
echo ""
echo "Run: npm run lint to see remaining warnings"
