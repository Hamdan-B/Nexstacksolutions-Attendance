import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

type RowObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bindParams(params: unknown[]): unknown {
  if (params.length === 1) {
    const [first] = params;
    if (isPlainObject(first)) {
      return first;
    }
  }
  return params;
}

export interface SqliteStatement {
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number };
  get: (...params: unknown[]) => RowObject | undefined;
  all: (...params: unknown[]) => RowObject[];
}

export class SqliteStore {
  private readonly db: Database.Database;
  private readonly filePath: string;

  private constructor(db: Database.Database, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  static async open(filePath: string): Promise<SqliteStore> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new Database(filePath);
    return new SqliteStore(db, filePath);
  }

  pragma(statement: string): void {
    this.db.pragma(statement);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const statement = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const result = statement.run(bindParams(params) as never);
        return {
          changes: Number(result.changes ?? 0),
          lastInsertRowid: Number(result.lastInsertRowid ?? 0)
        };
      },
      get: (...params: unknown[]) => {
        return statement.get(bindParams(params) as never) as RowObject | undefined;
      },
      all: (...params: unknown[]) => {
        return statement.all(bindParams(params) as never) as RowObject[];
      }
    };
  }

  transaction<T extends unknown[]>(callback: (...items: T) => void): (...items: T) => void {
    return (...items: T) => {
      this.db.exec('BEGIN');
      try {
        callback(...items);
        this.db.exec('COMMIT');
      } catch (error) {
        // Preserve the original failure; rollback may itself fail if SQLite already aborted the transaction.
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // no-op
        }
        throw error;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}