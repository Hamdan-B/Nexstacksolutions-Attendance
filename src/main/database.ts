import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { SqliteStore } from './sqlite';

export function getDatabasePath(): string {
  const baseDir = app.getPath('userData');
  fs.mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, 'nexstacksolutions.sqlite');
}

export async function openDatabase() {
  const db = await SqliteStore.open(getDatabasePath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runSchema(db: SqliteStore, schemaSql: string): void {
  db.exec(schemaSql);
}