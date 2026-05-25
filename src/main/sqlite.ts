import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type SqlJsDatabase } from 'sql.js';

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
  private readonly db: SqlJsDatabase;
  private readonly filePath: string;

  private constructor(db: SqlJsDatabase, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  static async open(filePath: string): Promise<SqliteStore> {
    const sqlJs = await initSqlJs({ locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`) });
    const db = fs.existsSync(filePath) ? new sqlJs.Database(fs.readFileSync(filePath)) : new sqlJs.Database();
    return new SqliteStore(db, filePath);
  }

  pragma(statement: string): void {
    this.db.exec(`PRAGMA ${statement};`);
    this.persist();
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.persist();
  }

  prepare(sql: string): SqliteStatement {
    return {
      run: (...params: unknown[]) => {
        const bound = bindParams(params);
        this.db.run(sql, bound as never);
        const changes = this.db.getRowsModified();
        const rowId = this.db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0];
        this.persist();
        return { changes, lastInsertRowid: Number(rowId ?? 0) };
      },
      get: (...params: unknown[]) => {
        const statement = this.db.prepare(sql);
        statement.bind(bindParams(params) as never);
        const row = statement.step() ? statement.getAsObject() : undefined;
        statement.free();
        return row;
      },
      all: (...params: unknown[]) => {
        const statement = this.db.prepare(sql);
        statement.bind(bindParams(params) as never);
        const rows: RowObject[] = [];
        while (statement.step()) {
          rows.push(statement.getAsObject());
        }
        statement.free();
        return rows;
      }
    };
  }

  transaction<T extends unknown[]>(callback: (...items: T) => void): (...items: T) => void {
    return (...items: T) => {
      this.db.exec('BEGIN');
      try {
        callback(...items);
        this.db.exec('COMMIT');
        this.persist();
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
    this.persist();
    this.db.close();
  }

  private persist(): void {
    const buffer = Buffer.from(this.db.export());
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, buffer);
  }
}