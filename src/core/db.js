/** Thin, promise-free helper layer over a sql.js database handle. */

export function quote(ident) {
  return `"${String(ident).replaceAll('"', '""')}"`;
}

export function run(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
}

export function select(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

/** All rows of a table as plain objects, ordered by `_id` when present. */
export function all(db, table) {
  const hasId = columns(db, table).includes('_id');
  return select(db, `SELECT * FROM ${quote(table)}${hasId ? ' ORDER BY _id' : ''}`);
}

export function count(db, table) {
  return select(db, `SELECT COUNT(*) AS n FROM ${quote(table)}`)[0].n;
}

/** Column names of a table, in declaration order. */
export function columns(db, table) {
  const res = db.exec(`PRAGMA table_info(${quote(table)})`)[0];
  return res ? res.values.map((row) => row[1]) : [];
}

export function insert(db, table, cols, values) {
  const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(', ')}) ` +
    `VALUES (${cols.map(() => '?').join(', ')})`;
  run(db, sql, values);
  return select(db, 'SELECT last_insert_rowid() AS id')[0].id;
}

export function userVersion(db) {
  return select(db, 'PRAGMA user_version')[0].user_version;
}

export function integrityCheck(db) {
  return select(db, 'PRAGMA integrity_check')[0].integrity_check;
}

/**
 * Schema of every user table: `Map<name, { columns: string[], ddl: string }>`.
 * DDL whitespace is normalised so two files written by the same app match.
 */
export function schema(db) {
  const tables = new Map();
  for (const row of select(db,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    tables.set(row.name, {
      columns: columns(db, row.name),
      ddl: String(row.sql ?? '').replace(/\s+/g, ' ').trim(),
    });
  }
  return tables;
}
