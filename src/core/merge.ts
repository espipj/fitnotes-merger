/** 
 * The merge engine.
 *
 * Takes any number of FitNotes backup files (SQLite databases) and returns a
 * single merged database, entirely in memory.
 *
 * Rules, derived from adapters.ts:
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

import type { Database as SqlJsDatabase } from 'sql.js';
import { getSqlite, openDatabase } from './sqlite.js';
import {
  all,
  count,
  insert,
  integrityCheck,
  schema,
  select,
  userVersion,
  type DbRow,
  type TableSchema,
} from './db.js';
import {
  ENTITIES,
  ROUTINE,
  TRAINING_LOG,
  VALUE_TABLES,
  STATIC_TABLES,
  type EntityAdapter,
  type RoutineAdapter,
  type ValueAdapter,
} from './adapters.js';

interface NameTableSpec {
  table: string;
  col: string | ((row: DbRow) => string | null) | null;
}

const NAME_TABLES: Record<string, NameTableSpec> = {
  category: { table: 'Category', col: 'name' },
  exercise: { table: 'exercise', col: 'name' },
  measurement: { table: 'Measurement', col: 'name' },
  routine_section: { table: 'RoutineSection', col: 'name' },
  routine_section_exercise: { table: 'RoutineSectionExercise', col: null },
  routine_section_exercise_set: { table: 'RoutineSectionExerciseSet', col: null },
  workout_group: { table: 'WorkoutGroup', col: (row) => `${row.name} (${row.date})` },
};

function normalizeName(value: string): string {
  return String(value)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function canonicalRows(rows: DbRow[]): string[] {
  return rows
    .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== '_id'))))
    .sort();
}

function sameRows(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sourceStats(db: SqlJsDatabase): SourceStats {
  const span = select<{ first: string | null; last: string | null }>(db, 'SELECT MIN(date) AS first, MAX(date) AS last FROM training_log')[0];
  return {
    sets: count(db, 'training_log'),
    exercises: count(db, 'exercise'),
    firstDate: span?.first ?? null,
    lastDate: span?.last ?? null,
  };
}

interface SourceStats {
  sets: number;
  exercises: number;
  firstDate: string | null;
  lastDate: string | null;
}

class Source {
  public index: number;
  public name: string;
  public db: SqlJsDatabase;
  public schema: Map<string, TableSchema>;
  public userVersion: number;
  public stats: SourceStats;
  private rowCache = new Map<string, DbRow[]>();

  constructor(index: number, name: string, db: SqlJsDatabase) {
    this.index = index;
    this.name = name;
    this.db = db;
    this.schema = schema(db);
    this.userVersion = userVersion(db);
    this.stats = sourceStats(db);
  }

  public cols(table: string): string[] {
    return this.schema.get(table)?.columns.filter((column) => column !== '_id') ?? [];
  }

  public rows(table: string): DbRow[] {
    if (!this.rowCache.has(table)) {
      this.rowCache.set(table, this.schema.has(table) ? all(this.db, table) : []);
    }
    return this.rowCache.get(table)!;
  }

  public close(): void {
    this.db.close();
  }
}

function assertFitNotes(source: Source): void {
  if (!source.schema.has('training_log') || !source.schema.has('exercise')) {
    throw new Error(`${source.name} is not a FitNotes backup (missing training_log/exercise tables)`);
  }
}

function validateCompatible(sources: Source[]): void {
  const problems: string[] = [];
  const first = sources[0];
  const firstTables = [...first.schema.keys()];
  if (sources.some((source) => source.userVersion !== first.userVersion)) {
    problems.push('schema versions differ: ' + sources.map((source) => `${source.name} (v${source.userVersion})`).join(', '));
  }
  for (const source of sources.slice(1)) {
    if ([...source.schema.keys()].join('|') !== firstTables.join('|')) {
      problems.push(`${source.name} has a different set of tables`);
      continue;
    }
    for (const table of firstTables) {
      const a = first.schema.get(table)!.columns.join('|');
      const b = source.schema.get(table)!.columns.join('|');
      if (a !== b) problems.push(`${source.name}: table "${table}" has different columns`);
    }
  }
  if (problems.length) {
    throw new Error('the backups are not compatible:\n- ' + problems.join('\n- '));
  }
}

function pickBase(sources: Source[]): number {
  let best = 0;
  for (let i = 1; i < sources.length; i += 1) {
    if (
      sources[i].stats.sets > sources[best].stats.sets ||
      (sources[i].stats.sets === sources[best].stats.sets &&
        sources[i].stats.exercises > sources[best].stats.exercises)
    ) {
      best = i;
    }
  }
  return best;
}

interface ReportTableEntry {
  table: string;
  added: number;
  duplicates: number;
  skipped: number;
}

class Report {
  public baseIndex: number;
  public files: FileStats[];
  private tables = new Map<string, ReportTableEntry>();
  public warnings: string[] = [];

  constructor(files: FileStats[], baseIndex: number) {
    this.baseIndex = baseIndex;
    this.files = files;
  }

  private entry(table: string): ReportTableEntry {
    if (!this.tables.has(table)) {
      this.tables.set(table, { table, added: 0, duplicates: 0, skipped: 0 });
    }
    return this.tables.get(table)!;
  }

  public add(table: string): void {
    this.entry(table).added += 1;
  }
  public duplicate(table: string): void {
    this.entry(table).duplicates += 1;
  }
  public skip(table: string): void {
    this.entry(table).skipped += 1;
  }
  public warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  public finish(into: { integrity: string; totals: { sets: number; exercises: number } }): MergeReport {
    return {
      base: this.baseIndex,
      files: this.files,
      tables: [...this.tables.values()].filter((t) => t.added || t.duplicates || t.skipped),
      warnings: this.warnings,
      ...into,
    };
  }
}

export interface FileStats {
  name: string;
  sets: number;
  exercises: number;
  firstDate: string | null;
  lastDate: string | null;
  userVersion: number;
}

export interface MergeReport {
  base: number;
  files: FileStats[];
  tables: ReportTableEntry[];
  warnings: string[];
  integrity: string;
  totals: { sets: number; exercises: number };
}

type ProgressPhase = 'open' | 'merge' | 'merged' | 'done';

export interface ProgressEvent {
  phase: ProgressPhase;
  index?: number;
  name?: string;
  sets?: number;
  exercises?: number;
}

const ALL_TABLES = new Set([
  ...ENTITIES.map((e) => e.table),
  ROUTINE.table,
  ...ROUTINE.children.map((c) => c.table),
  TRAINING_LOG.table,
  ...VALUE_TABLES.map((v) => v.table),
  ...STATIC_TABLES,
]);

class MergeContext {
  public db: SqlJsDatabase;
  public report: Report;
  private sourceNames = new Map<number, Map<string, Map<number, string | null>>>();
  private idMaps = new Map<string, Map<number, number>>();
  private dstNames = new Map<string, Map<string, number>>();
  private dstNormNames = new Map<string, Map<string, string>>();
  private mergedCounts = new Map<string, Map<string, number>>();
  private keyToId = new Map<string, Map<string, number>>();
  private routineNames: Map<string, number> | null = null;
  private staticSnapshot = new Map<string, string[]>();
  private warned = new Set<string>();
  private coveredTables = ALL_TABLES;

  constructor(merged: SqlJsDatabase, report: Report) {
    this.db = merged;
    this.report = report;
  }

  private namesFor(source: Source): Map<string, Map<number, string | null>> {
    if (!this.sourceNames.has(source.index)) {
      const maps = new Map<string, Map<number, string | null>>();
      for (const [entity, spec] of Object.entries(NAME_TABLES)) {
        const map = new Map<number, string | null>();
        for (const row of source.rows(spec.table)) {
          map.set(
            row._id as number,
            spec.col
              ? typeof spec.col === 'function'
                ? spec.col(row)
                : String(row[spec.col as string])
              : null,
          );
        }
        maps.set(entity, map);
      }
      this.sourceNames.set(source.index, maps);
    }
    return this.sourceNames.get(source.index)!;
  }

  public name(source: Source, entity: string, id: number | null | undefined): string {
    if (id === null || id === undefined || id === 0) return '(none)';
    const name = this.namesFor(source).get(entity)?.get(id);
    return name == null ? `?${id}` : name;
  }

  public nameList(source: Source, entity: string, value: string | null | undefined): string | null | undefined {
    if (value === null || value === undefined) return value;
    return String(value)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (/^\d+$/.test(part) ? this.name(source, entity, Number(part)) : part))
      .join(',');
  }

  public names(source: Source): NameFn {
    const fn = (entity: string, value: number | string | null | undefined): string =>
      this.name(source, entity, value as number | null | undefined);
    fn.list = (entity: string, value: unknown): string => this.nameList(source, entity, value as string | null | undefined);
    return fn;
  }

  private idMap(source: Source, entity: string): Map<number, number> {
    const key = `${source.index}:${entity}`;
    if (!this.idMaps.has(key)) this.idMaps.set(key, new Map());
    return this.idMaps.get(key)!;
  }

  private dstNameMap(entity: string): Map<string, number> {
    if (!this.dstNames.has(entity)) {
      const spec = NAME_TABLES[entity];
      const map = new Map<string, number>();
      for (const row of all(this.db, spec.table)) {
        map.set(typeof spec.col === 'function' ? spec.col(row) : String(row[spec.col as string]), row._id as number);
      }
      this.dstNames.set(entity, map);
    }
    return this.dstNames.get(entity)!;
  }

  private dstNormNameMap(entity: string): Map<string, string> {
    if (!this.dstNormNames.has(entity)) {
      const map = new Map<string, string>();
      for (const name of this.dstNameMap(entity).keys()) map.set(normalizeName(name), name);
      this.dstNormNames.set(entity, map);
    }
    return this.dstNormNames.get(entity)!;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.report.warn(message);
  }

  /** Resolves a reference: mapped id, or `undefined` when unknown. */
  public remap(source: Source, entity: string, value: number | null | undefined): number | undefined {
    if (value === null || value === undefined || value === 0) return value as number | undefined;
    const map = this.idMap(source, entity);
    return map.has(value) ? map.get(value) : undefined;
  }

  /** Builds insertable values for a row, applying every remap rule. */
  public buildValues(
    spec: EntityAdapter | RoutineAdapter | ValueAdapter,
    source: Source,
    row: DbRow,
  ): { cols: string[]; values: unknown[]; skipped: boolean; reason?: string } {
    const cols = source.cols(spec.table);
    const values: unknown[] = [];
    for (const col of cols) {
      let value: unknown = row[col];
      if ('remap' in spec && spec.remap?.[col]) {
        const entity = (spec.remap as Record<string, string>)[col];
        const mapped = this.remap(source, entity, value as number | null | undefined);
        if (mapped === undefined) {
          if ((spec as ValueAdapter).onUnknownRef === 'skip') {
            this.warnOnce(
              `${spec.table}.${col}.unknown`,
              `"${spec.table}" rows in ${source.name} reference unknown ${entity} ids; those rows were skipped`,
            );
            return { cols, values, skipped: true, reason: `unknown ${entity} id ${value}` };
          }
          this.warnOnce(
            `${spec.table}.${col}`,
            `"${spec.table}" rows in ${source.name} reference unknown ${entity} ids; copied unchanged`,
          );
        } else {
          value = mapped;
        }
      } else if ('remapOptional' in spec && spec.remapOptional?.[col]) {
        const { entity, fallback } = (spec.remapOptional as Record<string, { entity: string; fallback: number | null }>)[col];
        const mapped = this.remap(source, entity, value as number | null | undefined);
        value = mapped === undefined ? fallback : mapped;
      } else if ('remapList' in spec && spec.remapList?.[col]) {
        value = this.remapListValue(source, (spec.remapList as Record<string, string>)[col], value);
      }
      values.push(value);
    }
    return { cols, values, skipped: false };
  }

  private remapListValue(source: Source, entity: string, value: unknown): string {
    if (value === null || value === undefined) return value as string;
    return String(value)
      .split(',')
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
  public prepareBase(baseSource: Source): void {
    for (const spec of [TRAINING_LOG, ...VALUE_TABLES]) {
      const counts = new Map<string, number>();
      const ids = new Map<string, number>();
      const keys = this.names(baseSource);
      for (const row of baseSource.rows(spec.table)) {
        const key = spec.key(row, keys);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!ids.has(key)) ids.set(key, row._id as number);
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

  public mergeEntities(source: Source): void {
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
            this.report.warn(
              `"${name}" (${source.name}) differs from "${near}" only by case/whitespace; kept as a separate entry`,
            );
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
        idMap.set(row._id as number, newId);
      }
    }
  }

  public mergeRoutines(source: Source): void {
    const routines = source.rows(ROUTINE.table);
    if (!routines.length) return;
    if (!this.routineNames) {
      this.routineNames = new Map(all(this.db, ROUTINE.table).map((row) => [String(row.name), row._id as number]));
    }
    
    const byParentCorrect = new Map<string, Map<number, DbRow[]>>();
    for (const child of ROUTINE.children) {
      const groups = new Map<number, DbRow[]>();
      for (const row of source.rows(child.table)) {
        const parent = row[child.fk] as number;
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent)!.push(row);
      }
      byParentCorrect.set(child.table, groups);
    }

    const parents = ['routine', 'routine_section', 'routine_section_exercise'];
    for (const routine of routines) {
      const name = String(routine[ROUTINE.matchBy]);
      if (this.routineNames.has(name)) {
        this.report.skip(ROUTINE.table);
        this.report.warn(
          `routine "${name}" (${source.name}) already exists in the base file; its sections were not merged`,
        );
        continue;
      }
      const built = this.buildValues({ table: ROUTINE.table } as RoutineAdapter, source, routine);
      const routineId = insert(this.db, ROUTINE.table, built.cols, built.values);
      this.routineNames.set(name, routineId);
      this.idMap(source, 'routine').set(routine._id as number, routineId);
      this.report.add(ROUTINE.table);

      let childRows = byParentCorrect.get(ROUTINE.children[0].table)?.get(routine._id as number) ?? [];
      ROUTINE.children.forEach((child, depth) => {
        const parentEntity = parents[depth];
        const nextRows: DbRow[] = [];
        for (const row of childRows) {
          const spec: ValueAdapter = {
            table: child.table,
            remap: { [child.fk]: parentEntity },
            onUnknownRef: 'skip',
          };
          const builtChild = this.buildValues(spec, source, row);
          if (builtChild.skipped) {
            this.report.skip(child.table);
            continue;
          }
          const newId = insert(this.db, child.table, builtChild.cols, builtChild.values);
          this.idMap(source, child.entity).set(row._id as number, newId);
          this.report.add(child.table);
          if (depth + 1 < ROUTINE.children.length) {
            nextRows.push(...(byParentCorrect.get(ROUTINE.children[depth + 1].table)?.get(row._id as number) ?? []));
          }
        }
        childRows = nextRows;
      });
    }
  }

  public mergeValueTable(spec: ValueAdapter, source: Source): void {
    const rows = source.rows(spec.table);
    if (!rows.length) return;
    const counts = this.mergedCounts.get(spec.table);
    const keyToId = this.keyToId.get(spec.table);
    const keys = this.names(source);

    // Per-key state for this source: how many rows may match existing ones
    // and how many are new (identical rows merge as max, not sum).
    const sourceCounts = new Map<string, number>();
    for (const row of rows) {
      const key = spec.key(row, keys);
      sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
    }
    const state = new Map<string, { match: number; inserted: boolean }>();
    for (const [key, total] of sourceCounts) {
      const available = counts?.get(key) ?? 0;
      state.set(key, { match: Math.min(available, total), inserted: false });
      if (total > available) counts?.set(key, total);
    }

    for (const row of rows) {
      const key = spec.key(row, keys);
      const current = state.get(key);
      if (current?.match && current.match > 0) {
        current.match -= 1;
        this.report.duplicate(spec.table);
        if (spec.entity && keyToId?.has(key)) {
          this.idMap(source, spec.entity).set(row._id as number, keyToId.get(key)!);
        }
        continue;
      }
      const built = this.buildValues(spec, source, row);
      if (built.skipped) {
        this.report.skip(spec.table);
        continue;
      }
      const newId = insert(this.db, spec.table, built.cols, built.values);
      current!.inserted = true;
      if (!keyToId?.has(key)) keyToId?.set(key, newId);
      if (spec.entity) this.idMap(source, spec.entity).set(row._id as number, newId);
      this.report.add(spec.table);
    }
  }

  public mergeEvents(source: Source): void {
    this.mergeValueTable(TRAINING_LOG, source);
    for (const spec of VALUE_TABLES) this.mergeValueTable(spec, source);
  }

  public checkStatic(source: Source): void {
    for (const table of STATIC_TABLES) {
      if (!source.schema.has(table)) continue;
      const snapshot = this.staticSnapshot.get(table) ?? [];
      if (!sameRows(snapshot, canonicalRows(source.rows(table)))) {
        this.report.warn(
          `"${table}" differs between ${source.name} and the base file; the base values were kept`,
        );
      }
    }
  }

  public warnUnsupported(source: Source): void {
    for (const table of source.schema.keys()) {
      if (this.coveredTables.has(table) || table.startsWith('sqlite_')) continue;
      const rows = source.rows(table);
      if (!rows.length) continue;
      const baseRows = canonicalRows(all(this.db, table));
      if (!sameRows(canonicalRows(rows), baseRows)) {
        this.report.warn(
          `table "${table}" has ${rows.length} rows in ${source.name} that are not merged yet`,
        );
      }
    }
  }

  public append(source: Source): void {
    this.mergeEntities(source);
    this.mergeRoutines(source);
    this.mergeEvents(source);
    this.checkStatic(source);
    this.warnUnsupported(source);
  }
}

/** Reads a backup without merging, for previews in the UI. */
export async function inspectBackup(bytes: Uint8Array): Promise<{ ok: true; userVersion: number; sets: number; exercises: number; firstDate: string; lastDate: string; tables: number } | { ok: false; error: string }> {
  let db: SqlJsDatabase | undefined;
  try {
    db = await openDatabase(new Uint8Array(bytes));
    if (!schema(db).has('training_log') || !schema(db).has('exercise')) {
      throw new Error('not a FitNotes backup (missing tables)');
    }
    const stats = sourceStats(db);
    return {
      ok: true,
      userVersion: userVersion(db),
      sets: stats.sets,
      exercises: stats.exercises,
      firstDate: stats.firstDate ?? '',
      lastDate: stats.lastDate ?? '',
      tables: schema(db).size,
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Performance statistics collected during a merge. */
export interface MergePerformance {
  startTime: number;
  totalDuration: number;
  mergeDuration: number;
  totalOperations: number;
  operationsPerSecond: number;
  phases: Record<string, number>;
  rowCounts: Record<string, number>;
  memory?: {
    before: number;
    after: number;
    delta: number;
  };
}

/** Result of mergeBackups including performance stats. */
export interface MergeResult {
  bytes: Uint8Array;
  report: MergeReport;
  baseIndex: number;
  _performance?: MergePerformance;
}

/**
 * Merges two or more backups.
 *
 * @param files - Array of { name, bytes } objects
 * @param options - Optional configuration
 * @returns Promise resolving to merged bytes and report
 */
export async function mergeBackups(
  files: { name: string; bytes: Uint8Array }[],
  options: { baseIndex?: number; onProgress?: (event: ProgressEvent) => void } = {},
): Promise<MergeResult> {
  const { baseIndex, onProgress = () => {} } = options;
  if (!Array.isArray(files) || files.length < 2) {
    throw new Error('pass at least two backups to merge');
  }

  // Performance timing
  const perf = {
    startedAt: performance.now(),
    phases: new Map<string, number>(),
    rowCounts: new Map<string, number>(),
    memorySnapshots: new Map<string, number>(),
  };

  const sources: Source[] = [];
  try {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (!file?.bytes?.length) throw new Error(`file ${i + 1} (${file?.name ?? '?'}) is empty`);
      const phaseStart = performance.now();
      const db = await openDatabase(new Uint8Array(file.bytes));
      sources.push(new Source(i, file.name ?? `file ${i + 1}`, db));
      assertFitNotes(sources[i]);
      perf.phases.set(`open_${i}`, performance.now() - phaseStart);
      onProgress({ phase: 'open', index: i, name: sources[i].name });
    }
    validateCompatible(sources);

    const base =
      Number.isInteger(baseIndex) && baseIndex >= 0 && baseIndex < sources.length
        ? baseIndex
        : pickBase(sources);
    const baseSource = sources[base];
    const report = new Report(
      sources.map((source) => ({
        name: source.name,
        ...source.stats,
        userVersion: source.userVersion,
      })),
      base,
    );

    // Capture initial memory state (if available)
    if (typeof performance !== 'undefined' && 'memory' in performance) {
      const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
      perf.memorySnapshots.set('before_merge', mem?.usedJSHeapSize ?? 0);
    }

    const merged = await openDatabase(new Uint8Array(files[base].bytes));
    try {
      const mergeStart = performance.now();
      merged.run('BEGIN');
      const context = new MergeContext(merged, report);

      // Prepare base
      context.prepareBase(baseSource);

      // Track row counts per table
      for (const source of sources) {
        for (const table of source.schema.keys()) {
          const current = perf.rowCounts.get(table) ?? 0;
          perf.rowCounts.set(table, current + source.rows(table).length);
        }
      }

      for (const source of sources) {
        if (source.index === base) continue;
        onProgress({ phase: 'merge', index: source.index, name: source.name });

        const sourceStart = performance.now();
        context.append(source);
        const sourceDuration = performance.now() - sourceStart;
        perf.phases.set(`merge_${source.index}`, sourceDuration);

        onProgress({ phase: 'merged', index: source.index, name: source.name });
      }
      merged.run('COMMIT');

      const mergeDuration = performance.now() - mergeStart;
      perf.phases.set('total_merge', mergeDuration);

      const integrity = integrityCheck(merged);
      if (integrity !== 'ok') throw new Error(`merged database failed integrity_check: ${integrity}`);
      const totals = {
        sets: count(merged, 'training_log'),
        exercises: count(merged, 'exercise'),
      };
      onProgress({ phase: 'done', ...totals });

      // Capture final memory state (if available)
      if (typeof performance !== 'undefined' && 'memory' in performance) {
        const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
        perf.memorySnapshots.set('after_merge', mem?.usedJSHeapSize ?? 0);
      }

      // Calculate total operations - use the report's public tables property
      // Note: report.tables is populated during merge, we need to count from the merge report
      const reportTables = [...report.tables.values()];
      const totalOperations = reportTables.reduce((sum, t) => sum + t.added + t.duplicates + t.skipped, 0);

      // Performance summary for "nerds"
      const perfSummary: MergePerformance = {
        startTime: perf.startedAt,
        totalDuration: performance.now() - perf.startedAt,
        mergeDuration,
        totalOperations,
        operationsPerSecond: mergeDuration > 0 ? totalOperations / (mergeDuration / 1000) : 0,
        phases: Object.fromEntries(perf.phases),
        rowCounts: Object.fromEntries(perf.rowCounts),
      };

      // Memory info if available
      const beforeMem = perf.memorySnapshots.get('before_merge') ?? 0;
      const afterMem = perf.memorySnapshots.get('after_merge') ?? 0;
      if (beforeMem > 0 || afterMem > 0) {
        perfSummary.memory = {
          before: beforeMem,
          after: afterMem,
          delta: afterMem - beforeMem,
        };
      }

      // Log to console for developers/nerds
      console.log('🏋️ FitNotes Merger Performance Report');
      console.log('═'.repeat(50));
      console.log(`⏱  Total time:      ${perfSummary.totalDuration.toFixed(2)} ms`);
      console.log(`🔄  Merge time:      ${perfSummary.mergeDuration.toFixed(2)} ms`);
      console.log(`📊  Operations:      ${perfSummary.totalOperations} total`);
      console.log(`⚡  Ops/sec:         ${perfSummary.operationsPerSecond.toFixed(1)} ops/s`);
      console.log(`📁  Files merged:    ${files.length}`);
      console.log(`🗄️   Tables touched:  ${perfSummary.rowCounts ? Object.keys(perfSummary.rowCounts).length : 'N/A'}`);
      console.log('');
      console.log('Per-file breakdown:');
      for (const source of sources) {
        const phaseTime = perf.phases.get(`merge_${source.index}`) ?? 0;
        console.log(`  ${source.name}:`);
        console.log(`    Sets:        ${source.stats.sets}`);
        console.log(`    Exercises:   ${source.stats.exercises}`);
        console.log(`    Merge time:  ${phaseTime.toFixed(2)} ms`);
      }
      console.log('');
      console.log('Phase timings:');
      for (const [phase, time] of perf.phases) {
        console.log(`  ${phase.padEnd(15)}: ${time.toFixed(2)} ms`);
      }
      if (perfSummary.rowCounts && Object.keys(perfSummary.rowCounts).length > 0) {
        console.log('');
        console.log('Rows processed per table:');
        for (const [table, count] of Object.entries(perfSummary.rowCounts) as [string, number][]) {
          console.log(`  ${table.padEnd(30)}: ${count.toString().padStart(6)} rows`);
        }
      }
      if (perfSummary.memory) {
        console.log('');
        console.log('Memory usage:');
        console.log(`  Before: ${formatBytes(perfSummary.memory.before)}`);
        console.log(`  After:  ${formatBytes(perfSummary.memory.after)}`);
        console.log(`  Delta:  ${formatBytes(perfSummary.memory.delta)}`);
      }
      console.log('═'.repeat(50));

      const resultBaseIndex = base;
      return {
        bytes: merged.export(),
        baseIndex: resultBaseIndex,
        report: report.finish({ integrity, totals }),
        _performance: perfSummary,
      };
    } finally {
      merged.close();
    }
  } finally {
    for (const source of sources) {
      try {
        source.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

// Name function type for the names() method
type NameFn = {
  (entity: string, value: number | string | null | undefined): string;
  list: (entity: string, value: unknown) => string;
};
