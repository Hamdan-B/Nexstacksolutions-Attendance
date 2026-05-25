import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/main/sqlite';

describe('offline sqlite storage', () => {
  it('persists data to disk and reopens it', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexstacksqlite-'));
    const dbPath = path.join(tempDir, 'store.sqlite');
    const store = await SqliteStore.open(dbPath);
    store.exec('CREATE TABLE IF NOT EXISTS Demo (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
    store.prepare('INSERT INTO Demo (name) VALUES (?)').run('attendance');
    store.close();

    const reopened = await SqliteStore.open(dbPath);
    const row = reopened.prepare('SELECT name FROM Demo LIMIT 1').get();
    expect(row?.name).toBe('attendance');
    reopened.close();
  });
});