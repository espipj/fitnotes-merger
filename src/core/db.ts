/** Thin, promise-free helper layer over a sql.js database handle. */

import type { Database as SqlJsDatabase } from 'sql.js';

export type DbRow = Record<string, unknown>;

export function quote(ident: string): string {
  return `"${String(ident).replaceAll('"', '""')}"`;
}

/**
 * sql.js's params can be primitives, arrays, or nested arrays.
 * We accept `unknown[]` to be permissive for callers.
 */
export function run(
  db: SqlJsDatabase,
  sql: string,
  params: unknown[] = [],
): void {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
}

export function select<T extends DbRow = DbRow>(
  db: SqlJsDatabase,
  sql: string,
  params: unknown[] = [],
): T[] {
  const stmt = db.prepare(sql);
  const rows: T[] = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
  } finally {
    stmt.free();
  }
  return rows;
}

/** All rows of a table as plain objects, ordered by `_id` when present. */
export function all<T extends DbRow = DbRow>(db: SqlJsDatabase, table: string): T[] {
  const hasId = columns(db, table).includes('_id');
  return select<T>(
    db,
    `SELECT * FROM ${quote(table)}${hasId ? ' ORDER BY _id' : ''}`,
  );
}

export function count(db: SqlJsDatabase, table: string): number {
  return select(db, `SELECT COUNT(*) AS n FROM ${quote(table)}`)[0].n as number;
}

/** Column names of a table, in declaration order. */
export function columns(db: SqlJsDatabase, table: string): string[] {
  const res = db.exec(`PRAGMA table_info(${quote(table)})`);
  const first = res[0];
  return first ? first.values.map((row) => String(row[1])) : [];
}

export function insert(
  db: SqlJsDatabase,
  table: string,
  cols: string[],
  values: unknown[],
): number {
  const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(', ')}) ` +
    `VALUES (${cols.map(() => '?').join(', ')})`;
  run(db, sql, values);
  return select(db, 'SELECT last_insert_rowid() AS id')[0].id as number;
}

export function userVersion(db: SqlJsDatabase): number {
  return select(db, 'PRAGMA user_version')[0].user_version as number;
}

export function integrityCheck(db: SqlJsDatabase): string {
  return select(db, 'PRAGMA integrity_check')[0].integrity_check as string;
}

/**
 * Schema of every user table: `Map<name, { columns: string[], ddl: string }>`.
 * DDL whitespace is normalised so two files written by the same app match.
 */
export interface TableSchema {
  columns: string[];
  ddl: string;
}

export function schema(db: SqlJsDatabase): Map<string, TableSchema> {
  const tables = new Map<string, TableSchema>();
  for (const row of select<{ name: string; sql: string | null }>(
    db,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )) {
    tables.set(row.name, {
      columns: columns(db, row.name),
      ddl: String(row.sql ?? '').replace(/\s+/g, ' ').trim(),
    });
  }
  return tables;
}
