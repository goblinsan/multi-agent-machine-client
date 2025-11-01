# Dashboard Backend - SQLite Setup Instructions

## Issue: Native Module Compilation with Node 24

Node 24.2.0 requires C++20 and has V8 API changes that aren't compatible with current `better-sqlite3` versions.

## Recommended Solution: Use Node LTS 20.x

### Option 1: Install Node 20 via nvm (Recommended)

```bash
# Install nvm if you don't have it
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Install Node 20 LTS
nvm install 20
nvm use 20

# Verify
node --version  # Should show v20.x.x

# Install dependencies in the POC
cd src/dashboard-backend
rm -rf node_modules package-lock.json
npm install

# Start the server
npm run dev
```

### Option 2: Use Homebrew to install Node 20

```bash
# Unlink current node
brew unlink node

# Install Node 20
brew install node@20
brew link node@20

# Verify
node --version  # Should show v20.x.x

# Install dependencies
cd src/dashboard-backend
rm -rf node_modules package-lock.json
npm install
npm run dev
```

### Option 3: Build with Current Node (Advanced)

If you must use Node 24, you'll need to:

1. Wait for `better-sqlite3` to release a version compatible with Node 24's V8 API
2. Or use a different SQLite binding (e.g., `sql.js` which is WASM-based)

## After Successful Installation

Once dependencies install successfully:

```bash
# Start the server
npm run dev

# In another terminal, run smoke tests
curl -X POST http://localhost:3000/projects/1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Test task","description":"from curl"}'

curl http://localhost:3000/projects/1/tasks
```

## Alternative: Use sql.js (Pure JavaScript/WASM)

If native modules continue to be problematic, we can switch to `sql.js`:

```bash
npm uninstall better-sqlite3
npm install sql.js
```

This would require updating `src/db/connection.ts` to use sql.js's API, but avoids all native compilation issues.

Let me know which approach you prefer!
