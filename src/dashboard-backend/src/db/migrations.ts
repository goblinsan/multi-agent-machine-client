import { Database } from 'sql.js';
import { readFileSync } from 'fs';
import { join } from 'path';

export function runMigrations(db: Database): void {
  // Use the schema from docs/dashboard-api/schema.sql (authoritative)
  // Path is relative to src/dashboard-backend/src/db/migrations.ts
  const schemaPath = join(__dirname, '../../../../docs/dashboard-api/schema.sql');
  let schema = readFileSync(schemaPath, 'utf-8');
  
  // sql.js doesn't support WAL mode - remove those pragmas
  schema = schema.replace(/PRAGMA journal_mode = WAL;/g, '');
  schema = schema.replace(/PRAGMA synchronous = NORMAL;/g, '');

  db.run('PRAGMA foreign_keys = ON;');
  
  try {
    // Execute schema statements (sql.js exec doesn't support transactions the same way)
    db.exec(schema);
    
    // Create migrations table
    db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, 
      version TEXT NOT NULL UNIQUE, 
      description TEXT, 
      applied_at TEXT DEFAULT (datetime('now'))
    )`);
    
    // Record initial migration if needed
    const result = db.exec('SELECT version FROM schema_migrations WHERE version = ?', ['1.0.0']);
    if (!result || result.length === 0 || result[0].values.length === 0) {
      db.run('INSERT INTO schema_migrations (version, description) VALUES (?, ?)', ['1.0.0', 'Initial schema from docs']);
    }
  } catch (err) {
    console.error('Migration error:', err);
    throw err;
  }
}
