/**
 * The merge engine.
 *
 * Takes any number of FitNotes backup files (SQLite databases) and returns a
 * single merged database, entirely in memory.
 *
 * Rules, derived from adapters.js:
 *  - Categories / exercises / measurements are joined by name; ids remapped.
 *  - Routines are copied wholesale by name (existing routines are kept).
 *  - Event rows (workout sets, body weight, measurements, ...) are matched by
 *    a value key. Identical rows are merged as *max*, not sum: two backups of
 *    the same history with one copy of a set each do not double it, while a
 *    set logged twice on purpose stays twice.
 *  - Catalog/config tables (settings, plates, units) keep the base file's
 *    values; differences are reported as warnings.
 *
 * The base file (by default the one with the most workouts) supplies all
 * configuration and is copied byte-for-byte before anything is appended.
 */

import { openDatabase } from './sqlite.js';
import { all, count, insert, integrityCheck, schema, select, userVersion } from './db.js';
import { ENTITIES, ROUTINE, TRAINING_LOG, VALUE_TABLES, STATIC_TABLES } from './adapters.js';

const NAME_TABLES = {
  category: { table: 'Category', col: 'name' },
  exercise: { table: 'exercise', col: 'name' },
  measurement: { table: 'Measurement', col: 'name' },
  routine_section: { table: 'RoutineSection', col: 'name' },
  routine_section_exercise: { table: 'RoutineSectionExercise', col: null },
  routine_section_exercise_set: { table: 'RoutineSectionExerciseSet', col: null },
  workout_group: { table: 'WorkoutGroup', col: (row) => `${row.name} (${row.date})` },
};

function normalizeName(value) {
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalRows(rows) {
  return rows
    .map((row) => JSON.stringify(Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== '_id'),
    )))
    .sort();
}

function sameRows(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sourceStats(db) {
  const span = select(db, 'SELECT MIN(date) AS first, MAX(date) AS last FROM training_log')[0];
  return {
    sets: count(db, 'training_log'),
    exercises: count(db, 'exercise'),
    firstDate: span?.first ?? null,
    lastDate: span?.last ?? null,
  };
}

class Source {
  constructor(index, name, db) {
    this.index = index;
    this.name = name;
    this.db = db;
    this.schema = schema(db);
    this.userVersion = userVersion(db);
    this.stats = sourceStats(db);
    this.rowCache = new Map();
  }

  cols(table) {
    return this.schema.get(table)?.columns.filter((column) => column !== '_id') ?? [];
  }

  rows(table) {
    if (!this.rowCache.has(table)) {
      this.rowCache.set(table, this.schema.has(table) ? all(this.db, table) : []);
    }
    return this.rowCache.get(table);
  }

  close() {
    this.db.close();
  }
}

function assertFitNotes(source) {
  if (!source.schema.has('training_log') || !source.schema.has('exercise')) {
    throw new Error(`${source.name} is not a FitNotes backup (missing training_log/exercise tables)`);
  }
}

function validateCompatible(sources) {
  const problems = [];
  const first = sources[0];
  const firstTables = [...first.schema.keys()];
  if (sources.some((source) => source.userVersion !== first.userVersion)) {
    problems.push('schema versions differ: ' + sources
      .map((source) => `${source.name} (v${source.userVersion})`).join(', '));
  }
  for (const source of sources.slice(1)) {
    if ([...source.schema.keys()].join('|') !== firstTables.join('|')) {
      problems.push(`${source.name} has a different set of tables`);
      continue;
    }
    for (const table of firstTables) {
      const a = first.schema.get(table).columns.join('|');
      const b = source.schema.get(table).columns.join('|');
      if (a !== b) problems.push(`${source.name}: table "${table}" has different columns`);
    }
  }
  if (problems.length) {
    throw new Error('the backups are not compatible:\n- ' + problems.join('\n- '));
  }
}

function pickBase(sources) {
  let best = 0;
  for (let i = 1; i < sources.length; i += 1) {
    if (sources[i].stats.sets > sources[best].stats.sets
      || (sources[i].stats.sets === sources[best].stats.sets
        && sources[i].stats.exercises > sources[best].stats.exercises)) {
      best = i;
    }
  }
  return best;
}

class Report {
  constructor(files, baseIndex) {
    this.baseIndex = baseIndex;
    this.files = files;
    this.tables = new Map();
    this.warnings = [];
  }

  entry(table) {
    if (!this.tables.has(table)) {
      this.tables.set(table, { table, added: 0, duplicates: 0, skipped: 0 });
    }
    return this.tables.get(table);
  }

  add(table) { this.entry(table).added += 1; }
  duplicate(table) { this.entry(table).duplicates += 1; }
  skip(table) { this.entry(table).skipped += 1; }
  warn(message) { if (!this.warnings.includes(message)) this.warnings.push(message); }

  finish(into) {
    return {
      base: this.baseIndex,
      files: this.files,
      tables: [...this.tables.values()].filter((t) => t.added || t.duplicates || t.skipped),
      warnings: this.warnings,
      ...into,
    };
  }
}

class MergeContext {
  constructor(merged, report) {
    this.db = merged;
    this.report = report;
    this.sourceNames = new Map(); // sourceIndex -> entity -> Map(id -> name)
    this.idMaps = new Map(); // "sourceIndex:entity" -> Map(oldId -> newId)
    this.dstNames = new Map(); // entity -> Map(name -> id)
    this.dstNormNames = new Map(); // entity -> Map(normalizedName -> name)
    this.mergedCounts = new Map(); // table -> Map(key -> count)
    this.keyToId = new Map(); // table -> Map(key -> id)
    this.routineNames = null; // Map(name -> id)
    this.staticSnapshot = new Map(); // table -> canonical rows
    this.warned = new Set();
    this.coveredTables = new Set([
      ...ENTITIES.map((e) => e.table),
      ROUTINE.table,
      ...ROUTINE.children.map((c) => c.table),
      TRAINING_LOG.table,
      ...VALUE_TABLES.map((v) => v.table),
      ...STATIC_TABLES,
    ]);
  }

  namesFor(source) {
    if (!this.sourceNames.has(source.index)) {
      const maps = new Map();
      for (const [entity, spec] of Object.entries(NAME_TABLES)) {
        const map = new Map();
        for (const row of source.rows(spec.table)) {
          map.set(row._id, spec.col ? String(spec.col === 'name' ? row.name : spec.col(row)) : null);
        }
        maps.set(entity, map);
      }
      this.sourceNames.set(source.index, maps);
    }
    return this.sourceNames.get(source.index);
  }

  name(source, entity, id) {
    if (id === null || id === undefined || id === 0) return '(none)';
    const name = this.namesFor(source).get(entity)?.get(id);
    return name == null ? `?${id}` : name;
  }

  nameList(source, entity, value) {
    if (value === null || value === undefined) return value;
    return String(value).split(',').map((part) => part.trim()).filter(Boolean)
      .map((part) => (/^\d+$/.test(part) ? this.name(source, entity, Number(part)) : part))
      .join(',');
  }

  names(source) {
    const fn = (entity, id) => this.name(source, entity, id);
    fn.list = (entity, value) => this.nameList(source, entity, value);
    return fn;
  }

  idMap(source, entity) {
    const key = `${source.index}:${entity}`;
    if (!this.idMaps.has(key)) this.idMaps.set(key, new Map());
    return this.idMaps.get(key);
  }

  dstNameMap(entity) {
    if (!this.dstNames.has(entity)) {
      const spec = NAME_TABLES[entity];
      const map = new Map();
      for (const row of all(this.db, spec.table)) {
        map.set(String(spec.col === 'name' ? row.name : spec.col(row)), row._id);
      }
      this.dstNames.set(entity, map);
    }
    return this.dstNames.get(entity);
  }

  dstNormNameMap(entity) {
    if (!this.dstNormNames.has(entity)) {
      const map = new Map();
      for (const name of this.dstNameMap(entity).keys()) map.set(normalizeName(name), name);
      this.dstNormNames.set(entity, map);
    }
    return this.dstNormNames.get(entity);
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.report.warn(message);
  }

  /** Resolves a reference: mapped id, or `undefined` when unknown. */
  remap(source, entity, value) {
    if (value === null || value === undefined || value === 0) return value;
    const map = this.idMap(source, entity);
    return map.has(value) ? map.get(value) : undefined;
  }

  /** Builds insertable values for a row, applying every remap rule. */
  buildValues(spec, source, row) {
    const cols = source.cols(spec.table);
    const values = [];
    for (const col of cols) {
      let value = row[col];
      if (spec.remap?.[col]) {
        const entity = spec.remap[col];
        const mapped = this.remap(source, entity, value);
        if (mapped === undefined) {
          if (spec.onUnknownRef === 'skip') {
            this.warnOnce(`${spec.table}.${col}.unknown`,
              `"${spec.table}" rows in ${source.name} reference unknown ${entity} ids; those rows were skipped`);
            return { cols, values, skipped: true, reason: `unknown ${entity} id ${value}` };
          }
          this.warnOnce(`${spec.table}.${col}`,
            `"${spec.table}" rows in ${source.name} reference unknown ${entity} ids; copied unchanged`);
        } else {
          value = mapped;
        }
      } else if (spec.remapOptional?.[col]) {
        const { entity, fallback } = spec.remapOptional[col];
        const mapped = this.remap(source, entity, value);
        value = mapped === undefined ? fallback : mapped;
      } else if (spec.remapList?.[col]) {
        value = this.remapListValue(source, spec.remapList[col], value);
      }
      values.push(value);
    }
    return { cols, values, skipped: false };
  }

  remapListValue(source, entity, value) {
    if (value === null || value === undefined) return value;
    return String(value).split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        if (!/^\d+$/.test(trimmed)) return trimmed;
        const mapped = this.remap(source, entity, Number(trimmed));
        return mapped === undefined ? trimmed : String(mapped);
      })
      .join(',');
  }

  /** Fills entity maps + merged-row counters from the base file. */
  prepareBase(baseSource) {
    for (const spec of [TRAINING_LOG, ...VALUE_TABLES]) {
      const counts = new Map();
      const ids = new Map();
      const keys = this.names(baseSource);
      for (const row of baseSource.rows(spec.table)) {
        const key = spec.key(row, keys);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!ids.has(key)) ids.set(key, row._id);
      }
      this.mergedCounts.set(spec.table, counts);
      this.keyToId.set(spec.table, ids);
    }
    for (const table of STATIC_TABLES) {
      if (baseSource.schema.has(table)) {
        this.staticSnapshot.set(table, canonicalRows(baseSource.rows(table)));
      }
    }
  }

  mergeEntities(source) {
    for (const spec of ENTITIES) {
      const dst = this.dstNameMap(spec.entity);
      const norm = this.dstNormNameMap(spec.entity);
      const idMap = this.idMap(source, spec.entity);
      for (const row of source.rows(spec.table)) {
        const name = String(row[spec.matchBy]);
        let newId = dst.get(name);
        if (newId === undefined) {
          const near = norm.get(normalizeName(name));
          if (near && near !== name) {
            this.report.warn(`"${name}" (${source.name}) differs from "${near}" only by case/whitespace; kept as a separate entry`);
          }
          const built = this.buildValues(spec, source, row);
          if (built.skipped) {
            this.report.skip(spec.table);
            continue;
          }
          newId = insert(this.db, spec.table, built.cols, built.values);
          dst.set(name, newId);
          norm.set(normalizeName(name), name);
          this.report.add(spec.table);
        }
        idMap.set(row._id, newId);
      }
    }
  }

  mergeRoutines(source) {
    const routines = source.rows(ROUTINE.table);
    if (!routines.length) return;
    if (!this.routineNames) {
      this.routineNames = new Map(all(this.db, ROUTINE.table).map((row) => [String(row.name), row._id]));
    }
    const byParent = new Map();
    for (const child of ROUTINE.children) {
      const groups = new Map();
      for (const row of source.rows(child.table)) {
        const parent = row[child.fk];
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push(row);
      }
      byParent.set(child.table, groups);
    }

    const parents = ['routine', 'routine_section', 'routine_section_exercise'];
    for (const routine of routines) {
      const name = String(routine[ROUTINE.matchBy]);
      if (this.routineNames.has(name)) {
        this.report.skip(ROUTINE.table);
        this.report.warn(`routine "${name}" (${source.name}) already exists in the base file; its sections were not merged`);
        continue;
      }
      const built = this.buildValues({ table: ROUTINE.table }, source, routine);
      const routineId = insert(this.db, ROUTINE.table, built.cols, built.values);
      this.routineNames.set(name, routineId);
      this.idMap(source, 'routine').set(routine._id, routineId);
      this.report.add(ROUTINE.table);

      let childRows = byParent.get(ROUTINE.children[0].table)?.get(routine._id) ?? [];
      ROUTINE.children.forEach((child, depth) => {
        const parentEntity = parents[depth];
        const nextRows = [];
        for (const row of childRows) {
          const spec = {
            table: child.table,
            remap: { [child.fk]: parentEntity, ...(child.remap ?? {}) },
            onUnknownRef: 'skip',
          };
          const builtChild = this.buildValues(spec, source, row);
          if (builtChild.skipped) {
            this.report.skip(child.table);
            continue;
          }
          const newId = insert(this.db, child.table, builtChild.cols, builtChild.values);
          this.idMap(source, child.entity).set(row._id, newId);
          this.report.add(child.table);
          if (depth + 1 < ROUTINE.children.length) {
            nextRows.push(...(byParent.get(ROUTINE.children[depth + 1].table)?.get(row._id) ?? []));
          }
        }
        childRows = nextRows;
      });
    }
  }

  mergeValueTable(spec, source) {
    const rows = source.rows(spec.table);
    if (!rows.length) return;
    const counts = this.mergedCounts.get(spec.table);
    const keyToId = this.keyToId.get(spec.table);
    const keys = this.names(source);

    // Per-key state for this source: how many rows may match existing ones
    // and how many are new (identical rows merge as max, not sum).
    const sourceCounts = new Map();
    for (const row of rows) {
      const key = spec.key(row, keys);
      sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
    }
    const state = new Map();
    for (const [key, total] of sourceCounts) {
      const available = counts.get(key) ?? 0;
      state.set(key, { match: Math.min(available, total), inserted: false });
      if (total > available) counts.set(key, total);
    }

    for (const row of rows) {
      const key = spec.key(row, keys);
      const current = state.get(key);
      if (current.match > 0) {
        current.match -= 1;
        this.report.duplicate(spec.table);
        if (spec.entity && keyToId.has(key)) {
          this.idMap(source, spec.entity).set(row._id, keyToId.get(key));
        }
        continue;
      }
      const built = this.buildValues(spec, source, row);
      if (built.skipped) {
        this.report.skip(spec.table);
        continue;
      }
      const newId = insert(this.db, spec.table, built.cols, built.values);
      current.inserted = true;
      if (!keyToId.has(key)) keyToId.set(key, newId);
      if (spec.entity) this.idMap(source, spec.entity).set(row._id, newId);
      this.report.add(spec.table);
    }
  }

  mergeEvents(source) {
    this.mergeValueTable(TRAINING_LOG, source);
    for (const spec of VALUE_TABLES) this.mergeValueTable(spec, source);
  }

  checkStatic(source) {
    for (const table of STATIC_TABLES) {
      if (!source.schema.has(table)) continue;
      const snapshot = this.staticSnapshot.get(table) ?? [];
      if (!sameRows(snapshot, canonicalRows(source.rows(table)))) {
        this.report.warn(`"${table}" differs between ${source.name} and the base file; the base values were kept`);
      }
    }
  }

  warnUnsupported(source) {
    for (const table of source.schema.keys()) {
      if (this.coveredTables.has(table) || table.startsWith('sqlite_')) continue;
      const rows = source.rows(table);
      if (!rows.length) continue;
      const baseRows = canonicalRows(all(this.db, table));
      if (!sameRows(canonicalRows(rows), baseRows)) {
        this.report.warn(`table "${table}" has ${rows.length} rows in ${source.name} that are not merged yet`);
      }
    }
  }

  append(source) {
    this.mergeEntities(source);
    this.mergeRoutines(source);
    this.mergeEvents(source);
    this.checkStatic(source);
    this.warnUnsupported(source);
  }
}

/** Reads a backup without merging, for previews in the UI. */
export async function inspectBackup(bytes) {
  let db;
  try {
    db = await openDatabase(new Uint8Array(bytes));
    if (!schema(db).has('training_log') || !schema(db).has('exercise')) {
      throw new Error('not a FitNotes backup (missing tables)');
    }
    return {
      ok: true,
      userVersion: userVersion(db),
      ...sourceStats(db),
      tables: schema(db).size,
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Merges two or more backups.
 *
 * @param {{name: string, bytes: Uint8Array}[]} files
 * @param {{baseIndex?: number, onProgress?: (event: object) => void}} [options]
 * @returns {Promise<{bytes: Uint8Array, report: object, baseIndex: number}>}
 */
export async function mergeBackups(files, options = {}) {
  const { baseIndex, onProgress = () => {} } = options;
  if (!Array.isArray(files) || files.length < 2) {
    throw new Error('pass at least two backups to merge');
  }

  const sources = [];
  try {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (!file?.bytes?.length) throw new Error(`file ${i + 1} (${file?.name ?? '?'}) is empty`);
      const db = await openDatabase(new Uint8Array(file.bytes));
      sources.push(new Source(i, file.name ?? `file ${i + 1}`, db));
      assertFitNotes(sources[i]);
      onProgress({ phase: 'open', index: i, name: sources[i].name });
    }
    validateCompatible(sources);

    const base = Number.isInteger(baseIndex) && baseIndex >= 0 && baseIndex < sources.length
      ? baseIndex
      : pickBase(sources);
    const baseSource = sources[base];
    const report = new Report(
      sources.map((source) => ({ name: source.name, ...source.stats, userVersion: source.userVersion })),
      base,
    );

    const merged = await openDatabase(new Uint8Array(files[base].bytes));
    try {
      merged.run('BEGIN');
      const context = new MergeContext(merged, report);
      context.prepareBase(baseSource);
      for (const source of sources) {
        if (source.index === base) continue;
        onProgress({ phase: 'merge', index: source.index, name: source.name });
        context.append(source);
        onProgress({ phase: 'merged', index: source.index, name: source.name });
      }
      merged.run('COMMIT');

      const integrity = integrityCheck(merged);
      if (integrity !== 'ok') throw new Error(`merged database failed integrity_check: ${integrity}`);
      const totals = {
        sets: count(merged, 'training_log'),
        exercises: count(merged, 'exercise'),
      };
      onProgress({ phase: 'done', ...totals });
      return {
        bytes: merged.export(),
        baseIndex: base,
        report: report.finish({ integrity, totals }),
      };
    } finally {
      merged.close();
    }
  } finally {
    for (const source of sources) {
      try { source.close(); } catch { /* ignore */ }
    }
  }
}
