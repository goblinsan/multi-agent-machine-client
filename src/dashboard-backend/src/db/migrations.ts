import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

export function runMigrations(db: Database.Database): void {
  // Use the schema from docs/dashboard-api/schema.sql (authoritative)
  const schemaPath = join(__dirname, '../../../docs/dashboard-api/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');

  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(schema);
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL UNIQUE, description TEXT, applied_at TEXT DEFAULT (datetime('now')));");
    // Record initial migration if needed
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('1.0.0');
    if (!row) {
      db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run('1.0.0', 'Initial schema from docs');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
