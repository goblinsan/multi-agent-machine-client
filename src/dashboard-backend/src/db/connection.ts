import Database from 'better-sqlite3';
import { join } from 'path';
import fs from 'fs';

const DATA_DIR = join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DATABASE_PATH || join(DATA_DIR, 'dashboard.db');

let dbInstance: Database.Database | null = null;

export function createConnection(dbPath?: string): Database.Database {
  const path = dbPath || DB_PATH;
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

export function getDb(): Database.Database {
  if (!dbInstance) dbInstance = createConnection();
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
