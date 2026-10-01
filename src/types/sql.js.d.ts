declare module 'sql.js' {
  export interface Database {
    readonly columns: string[];
    readonly columns_unknown: string[];
    readonly executive: unknown;
    readonly name: string;
    readonly _, Database;
    readonly __extended: unknown;
    close(): void;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    export(): Uint8Array;
    getRowsModified(): number;
    run(sql: string, params?: unknown[]): void;
    readonly length: number;
  }

  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface Stmt {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(params?: unknown[]): Record<string, unknown>;
    run(params?: unknown[]): void;
    free(): void;
    readonly columns: string[];
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Uint8Array, config?: SqlJsConfig) => Database;
    stmt: {
      bind(stmt: Stmt, params?: unknown[]): boolean;
      step(stmt: Stmt): boolean;
      getAsObject(stmt: Stmt, params?: unknown[]): Record<string, unknown>;
      run(stmt: Stmt, params?: unknown[]): void;
      free(stmt: Stmt): void;
    };
  }

  export interface SqlJsConfig {
    locateFile?: (filename: string) => string;
  }

  export interface SqlJsUtils {
    // eslint-disable-next-line no-underscore-dangle
    _: unknown;
    // eslint-disable-next-line no-underscore-dangle
    __extended: unknown;
  }

  export type initSqlJs = (config?: SqlJsConfig) => Promise<SqlJsStatic>;

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
  export { Database, QueryExecResult, Stmt, SqlJsStatic, SqlJsConfig, SqlJsUtils, initSqlJs };
}
