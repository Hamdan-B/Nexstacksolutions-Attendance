declare module 'sql.js' {
  export interface SqlJsStatement {
    bind(params?: unknown): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  export interface SqlJsDatabase {
    exec(sql: string): Array<{ values: unknown[][] }>;
    run(sql: string, params?: unknown): void;
    prepare(sql: string): SqlJsStatement;
    getRowsModified(): number;
    close(): void;
    export(): Uint8Array;
  }

  export default function initSqlJs(options?: { locateFile?: (file: string) => string }): Promise<{ Database: new (data?: Uint8Array | ArrayBuffer) => SqlJsDatabase }>;
}