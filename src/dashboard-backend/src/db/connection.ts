import initSqlJs, { Database } from 'sql.js';
import { join } from 'path';
import fs from 'fs';

const DATA_DIR = join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DATABASE_PATH || join(DATA_DIR, 'dashboard.db');

let dbInstance: Database | null = null;
let SQL: any = null;

async function initSQL() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

export async function createConnection(dbPath?: string): Promise<Database> {
  const path = dbPath || DB_PATH;
  const SQLModule = await initSQL();
  
  let db: Database;
  if (fs.existsSync(path)) {
    const buffer = fs.readFileSync(path);
    db = new SQLModule.Database(buffer);
  } else {
    db = new SQLModule.Database();
  }
  
  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON;');
  
  return db;
}

export async function getDb(): Promise<Database> {
  if (!dbInstance) dbInstance = await createConnection();
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function saveDb(db: Database, dbPath?: string): void {
  const path = dbPath || DB_PATH;
  const data = db.export();
  fs.writeFileSync(path, Buffer.from(data));
}
