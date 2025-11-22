import { Database } from "sql.js";
import { readFileSync } from "fs";
import { join } from "path";

function ensureColumn(
  db: Database,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): void {
  const info = db.exec(`PRAGMA table_info(${tableName})`);
  const hasColumn = !!info?.[0]?.values?.some((row: any[]) => row[1] === columnName);

  if (!hasColumn) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    console.log(`Added missing column ${columnName} to ${tableName}`);
  }
}

export function ensureTaskSchemaUpgrades(db: Database): void {
  ensureColumn(db, "tasks", "blocked_dependencies", "TEXT");
}

export function runMigrations(db: Database): void {
  const tables = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'",
  );
  const schemaInitialized =
    tables && tables.length > 0 && tables[0].values.length > 0;

  if (schemaInitialized) {
    console.log("Database schema already initialized, skipping base migrations");
    db.run("PRAGMA foreign_keys = ON;");
  } else {
    const schemaPath = join(
      __dirname,
      "../../../../docs/dashboard-api/schema.sql",
    );
    let schema = readFileSync(schemaPath, "utf-8");

    schema = schema.replace(/PRAGMA journal_mode = WAL;/g, "");
    schema = schema.replace(/PRAGMA synchronous = NORMAL;/g, "");

    schema = schema.replace(/CREATE INDEX/g, "CREATE INDEX IF NOT EXISTS");

    db.run("PRAGMA foreign_keys = ON;");

    try {
      db.exec(schema);

      db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, 
      version TEXT NOT NULL UNIQUE, 
      description TEXT, 
      applied_at TEXT DEFAULT (datetime('now'))
    )`);

      const result = db.exec(
        "SELECT version FROM schema_migrations WHERE version = ?",
        ["1.0.0"],
      );
      if (!result || result.length === 0 || result[0].values.length === 0) {
        db.run(
          "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
          ["1.0.0", "Initial schema from docs"],
        );
      }
    } catch (err) {
      console.error("Migration error:", err);
      throw err;
    }
  }

  ensureTaskSchemaUpgrades(db);
}
