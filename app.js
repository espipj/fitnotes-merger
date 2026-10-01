// src/core/sqlite.ts
var vendorUrl = (path) => new URL(`vendor/${path}`, document.baseURI).href;
var isBrowser = () => typeof document !== "undefined";
var runtimePromise = null;
function injectScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(script);
  });
}
async function loadRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (globalThis.initSqlJs) return globalThis.initSqlJs;
    if (isBrowser()) {
      try {
        await injectScript(vendorUrl("sql-wasm.js"));
      } catch (loadError) {
        throw new Error(
          `failed to load vendor/sql-wasm.js: ${loadError?.message ?? String(loadError)}. If the file is missing, serving it from the same directory as index.html usually fixes this.`
        );
      }
      if (!globalThis.initSqlJs) {
        throw new Error(
          "vendor/sql-wasm.js loaded but did not expose initSqlJs. This can happen if the vendored file is outdated or was replaced by a different build."
        );
      }
      return globalThis.initSqlJs;
    }
    const mod = await import("sql.js");
    if (!mod || !("default" in mod) && typeof mod.initSqlJs !== "function") {
      throw new Error("sql.js did not export an initSqlJs entry point");
    }
    return mod.default ?? mod;
  })();
  return runtimePromise;
}
var sqlitePromise = null;
function getSqlite() {
  if (!sqlitePromise) {
    sqlitePromise = loadRuntime().then(
      (init) => init(isBrowser() ? { locateFile: (file) => vendorUrl(file) } : {})
    );
  }
  return sqlitePromise;
}
async function openDatabase(bytes) {
  const { Database } = await getSqlite();
  return new Database(bytes);
}

// src/core/db.ts
function quote(ident) {
  return `"${String(ident).replaceAll('"', '""')}"`;
}
function run(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
}
function select(db, sql, params = []) {
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
function all(db, table) {
  const hasId = columns(db, table).includes("_id");
  return select(
    db,
    `SELECT * FROM ${quote(table)}${hasId ? " ORDER BY _id" : ""}`
  );
}
function count(db, table) {
  return select(db, `SELECT COUNT(*) AS n FROM ${quote(table)}`)[0].n;
}
function columns(db, table) {
  const res = db.exec(`PRAGMA table_info(${quote(table)})`);
  const first = res[0];
  return first ? first.values.map((row) => String(row[1])) : [];
}
function insert(db, table, cols, values) {
  const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  run(db, sql, values);
  return select(db, "SELECT last_insert_rowid() AS id")[0].id;
}
function userVersion(db) {
  return select(db, "PRAGMA user_version")[0].user_version;
}
function integrityCheck(db) {
  return select(db, "PRAGMA integrity_check")[0].integrity_check;
}
function schema(db) {
  const tables = /* @__PURE__ */ new Map();
  for (const row of select(
    db,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )) {
    tables.set(row.name, {
      columns: columns(db, row.name),
      ddl: String(row.sql ?? "").replace(/\s+/g, " ").trim()
    });
  }
  return tables;
}

// src/core/adapters.ts
var ENTITIES = [
  { entity: "category", table: "Category", matchBy: "name" },
  {
    entity: "exercise",
    table: "exercise",
    matchBy: "name",
    remap: { category_id: "category" },
    onUnknownRef: "keep"
  },
  { entity: "measurement", table: "Measurement", matchBy: "name" }
];
var ROUTINE = {
  table: "Routine",
  matchBy: "name",
  children: [
    { table: "RoutineSection", fk: "routine_id", entity: "routine_section" },
    {
      table: "RoutineSectionExercise",
      fk: "routine_section_id",
      entity: "routine_section_exercise",
      remap: { exercise_id: "exercise" }
    },
    {
      table: "RoutineSectionExerciseSet",
      fk: "routine_section_exercise_id",
      entity: "routine_section_exercise_set"
    }
  ]
};
var TRAINING_LOG = {
  table: "training_log",
  remap: { exercise_id: "exercise" },
  onUnknownRef: "skip",
  remapOptional: { routine_section_exercise_set_id: { entity: "routine_section_exercise_set", fallback: 0 } },
  key: (row, name) => JSON.stringify([
    row.date,
    name("exercise", row.exercise_id),
    row.metric_weight,
    row.reps,
    row.unit,
    row.distance,
    row.duration_seconds
  ])
};
var VALUE_TABLES = [
  {
    table: "Barbell",
    remap: { exercise_id: "exercise" },
    key: (row, name) => JSON.stringify([name("exercise", row.exercise_id), row.weight, row.unit])
  },
  {
    table: "BodyWeight",
    key: (row) => JSON.stringify([row.date, row.body_weight_metric, row.body_fat, row.comments])
  },
  {
    table: "Goal",
    remap: { exercise_id: "exercise" },
    key: (row, name) => JSON.stringify([
      name("exercise", row.exercise_id),
      row.type_id,
      row.metric_weight,
      row.reps,
      row.unit,
      row.title,
      row.target_date,
      row.sort_order,
      row.distance,
      row.duration_seconds,
      row.start_date
    ])
  },
  {
    table: "MeasurementRecord",
    remap: { measurement_id: "measurement" },
    key: (row, name) => JSON.stringify([
      name("measurement", row.measurement_id),
      row.date,
      row.time,
      row.value,
      row.comment
    ])
  },
  {
    table: "Comment",
    note: "owner ids are copied as-is (owner_type_id is polymorphic)",
    key: (row) => JSON.stringify([row.date, row.owner_type_id, row.owner_id, row.comment])
  },
  {
    table: "WorkoutComment",
    key: (row) => JSON.stringify([row.date, row.comment])
  },
  {
    table: "WorkoutTime",
    key: (row) => JSON.stringify([row.workout_date, row.start_date_time, row.end_date_time])
  },
  {
    table: "WorkoutGroup",
    entity: "workout_group",
    remapOptional: { routine_section_id: { entity: "routine_section", fallback: null } },
    key: (row, name) => JSON.stringify([
      name("routine_section", row.routine_section_id),
      row.name,
      row.date,
      row.colour,
      row.auto_jump_enabled,
      row.rest_timer_auto_start_enabled
    ])
  },
  {
    table: "WorkoutGroupExercise",
    remap: { exercise_id: "exercise" },
    remapOptional: {
      routine_section_id: { entity: "routine_section", fallback: null },
      workout_group_id: { entity: "workout_group", fallback: 0 }
    },
    key: (row, name) => JSON.stringify([
      name("exercise", row.exercise_id),
      row.date,
      name("workout_group", row.workout_group_id)
    ])
  },
  {
    table: "ExerciseGraphFavourite",
    remap: { exercise_id: "exercise" },
    note: "group_id is copied without remapping",
    key: (row, name) => JSON.stringify([
      row.group_id,
      name("exercise", row.exercise_id),
      row.graph_type_id,
      row.time_period,
      row.sort_order,
      row.is_default
    ])
  },
  {
    table: "RepMaxGridFavourite",
    remapList: { exercise_ids: "exercise" },
    note: "exercise_ids is treated as a comma-separated id list",
    key: (row, name) => JSON.stringify([
      name.list("exercise", row.exercise_ids),
      row.rep_counts,
      row.is_default,
      row.sort_order
    ])
  }
];
var STATIC_TABLES = ["settings", "MeasurementUnit", "Plate", "android_metadata"];

// src/core/merge.ts
var NAME_TABLES = {
  category: { table: "Category", col: "name" },
  exercise: { table: "exercise", col: "name" },
  measurement: { table: "Measurement", col: "name" },
  routine_section: { table: "RoutineSection", col: "name" },
  routine_section_exercise: { table: "RoutineSectionExercise", col: null },
  routine_section_exercise_set: { table: "RoutineSectionExerciseSet", col: null },
  workout_group: { table: "WorkoutGroup", col: (row) => `${row.name} (${row.date})` }
};
function normalizeName(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
function canonicalRows(rows) {
  return rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "_id")))).sort();
}
function sameRows(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function sourceStats(db) {
  const span = select(db, "SELECT MIN(date) AS first, MAX(date) AS last FROM training_log")[0];
  return {
    sets: count(db, "training_log"),
    exercises: count(db, "exercise"),
    firstDate: span?.first ?? null,
    lastDate: span?.last ?? null
  };
}
var Source = class {
  index;
  name;
  db;
  schema;
  userVersion;
  stats;
  rowCache = /* @__PURE__ */ new Map();
  constructor(index, name, db) {
    this.index = index;
    this.name = name;
    this.db = db;
    this.schema = schema(db);
    this.userVersion = userVersion(db);
    this.stats = sourceStats(db);
  }
  cols(table) {
    return this.schema.get(table)?.columns.filter((column) => column !== "_id") ?? [];
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
};
function assertFitNotes(source) {
  if (!source.schema.has("training_log") || !source.schema.has("exercise")) {
    throw new Error(`${source.name} is not a FitNotes backup (missing training_log/exercise tables)`);
  }
}
function validateCompatible(sources) {
  const problems = [];
  const first = sources[0];
  const firstTables = [...first.schema.keys()];
  if (sources.some((source) => source.userVersion !== first.userVersion)) {
    problems.push("schema versions differ: " + sources.map((source) => `${source.name} (v${source.userVersion})`).join(", "));
  }
  for (const source of sources.slice(1)) {
    if ([...source.schema.keys()].join("|") !== firstTables.join("|")) {
      problems.push(`${source.name} has a different set of tables`);
      continue;
    }
    for (const table of firstTables) {
      const a = first.schema.get(table).columns.join("|");
      const b = source.schema.get(table).columns.join("|");
      if (a !== b) problems.push(`${source.name}: table "${table}" has different columns`);
    }
  }
  if (problems.length) {
    throw new Error("the backups are not compatible:\n- " + problems.join("\n- "));
  }
}
function pickBase(sources) {
  let best = 0;
  for (let i = 1; i < sources.length; i += 1) {
    if (sources[i].stats.sets > sources[best].stats.sets || sources[i].stats.sets === sources[best].stats.sets && sources[i].stats.exercises > sources[best].stats.exercises) {
      best = i;
    }
  }
  return best;
}
var Report = class {
  baseIndex;
  files;
  tables = /* @__PURE__ */ new Map();
  warnings = [];
  constructor(files, baseIndex) {
    this.baseIndex = baseIndex;
    this.files = files;
  }
  entry(table) {
    if (!this.tables.has(table)) {
      this.tables.set(table, { table, added: 0, duplicates: 0, skipped: 0 });
    }
    return this.tables.get(table);
  }
  add(table) {
    this.entry(table).added += 1;
  }
  duplicate(table) {
    this.entry(table).duplicates += 1;
  }
  skip(table) {
    this.entry(table).skipped += 1;
  }
  warn(message) {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }
  finish(into) {
    return {
      base: this.baseIndex,
      files: this.files,
      tables: [...this.tables.values()].filter((t) => t.added || t.duplicates || t.skipped),
      warnings: this.warnings,
      ...into
    };
  }
};
var ALL_TABLES = /* @__PURE__ */ new Set([
  ...ENTITIES.map((e) => e.table),
  ROUTINE.table,
  ...ROUTINE.children.map((c) => c.table),
  TRAINING_LOG.table,
  ...VALUE_TABLES.map((v) => v.table),
  ...STATIC_TABLES
]);
var MergeContext = class {
  db;
  report;
  sourceNames = /* @__PURE__ */ new Map();
  idMaps = /* @__PURE__ */ new Map();
  dstNames = /* @__PURE__ */ new Map();
  dstNormNames = /* @__PURE__ */ new Map();
  mergedCounts = /* @__PURE__ */ new Map();
  keyToId = /* @__PURE__ */ new Map();
  routineNames = null;
  staticSnapshot = /* @__PURE__ */ new Map();
  warned = /* @__PURE__ */ new Set();
  coveredTables = ALL_TABLES;
  constructor(merged, report) {
    this.db = merged;
    this.report = report;
  }
  namesFor(source) {
    if (!this.sourceNames.has(source.index)) {
      const maps = /* @__PURE__ */ new Map();
      for (const [entity, spec] of Object.entries(NAME_TABLES)) {
        const map = /* @__PURE__ */ new Map();
        for (const row of source.rows(spec.table)) {
          map.set(
            row._id,
            spec.col ? typeof spec.col === "function" ? spec.col(row) : String(row[spec.col]) : null
          );
        }
        maps.set(entity, map);
      }
      this.sourceNames.set(source.index, maps);
    }
    return this.sourceNames.get(source.index);
  }
  name(source, entity, id) {
    if (id === null || id === void 0 || id === 0) return "(none)";
    const name = this.namesFor(source).get(entity)?.get(id);
    return name == null ? `?${id}` : name;
  }
  nameList(source, entity, value) {
    if (value === null || value === void 0) return value;
    return String(value).split(",").map((part) => part.trim()).filter(Boolean).map((part) => /^\d+$/.test(part) ? this.name(source, entity, Number(part)) : part).join(",");
  }
  names(source) {
    const fn = (entity, value) => this.name(source, entity, value);
    fn.list = (entity, value) => this.nameList(source, entity, value);
    return fn;
  }
  idMap(source, entity) {
    const key = `${source.index}:${entity}`;
    if (!this.idMaps.has(key)) this.idMaps.set(key, /* @__PURE__ */ new Map());
    return this.idMaps.get(key);
  }
  dstNameMap(entity) {
    if (!this.dstNames.has(entity)) {
      const spec = NAME_TABLES[entity];
      const map = /* @__PURE__ */ new Map();
      for (const row of all(this.db, spec.table)) {
        map.set(typeof spec.col === "function" ? spec.col(row) : String(row[spec.col]), row._id);
      }
      this.dstNames.set(entity, map);
    }
    return this.dstNames.get(entity);
  }
  dstNormNameMap(entity) {
    if (!this.dstNormNames.has(entity)) {
      const map = /* @__PURE__ */ new Map();
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
    if (value === null || value === void 0 || value === 0) return value;
    const map = this.idMap(source, entity);
    return map.has(value) ? map.get(value) : void 0;
  }
  /** Builds insertable values for a row, applying every remap rule. */
  buildValues(spec, source, row) {
    const cols = source.cols(spec.table);
    const values = [];
    for (const col of cols) {
      let value = row[col];
      if ("remap" in spec && spec.remap?.[col]) {
        const entity = spec.remap[col];
        const mapped = this.remap(source, entity, value);
        if (mapped === void 0) {
          if (spec.onUnknownRef === "skip") {
            this.warnOnce(
              `${spec.table}.${col}.unknown`,
              `"${spec.table}" rows in ${source.name} reference unknown ${entity} ids; those rows were skipped`
            );
            return { cols, values, skipped: true, reason: `unknown ${entity} id ${value}` };
          }
          this.warnOnce(
            `${spec.table}.${col}`,
            `"${spec.table}" rows in ${source.name} reference unknown ${entity} ids; copied unchanged`
          );
        } else {
          value = mapped;
        }
      } else if ("remapOptional" in spec && spec.remapOptional?.[col]) {
        const { entity, fallback } = spec.remapOptional[col];
        const mapped = this.remap(source, entity, value);
        value = mapped === void 0 ? fallback : mapped;
      } else if ("remapList" in spec && spec.remapList?.[col]) {
        value = this.remapListValue(source, spec.remapList[col], value);
      }
      values.push(value);
    }
    return { cols, values, skipped: false };
  }
  remapListValue(source, entity, value) {
    if (value === null || value === void 0) return value;
    return String(value).split(",").map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      if (!/^\d+$/.test(trimmed)) return trimmed;
      const mapped = this.remap(source, entity, Number(trimmed));
      return mapped === void 0 ? trimmed : String(mapped);
    }).join(",");
  }
  /** Fills entity maps + merged-row counters from the base file. */
  prepareBase(baseSource) {
    for (const spec of [TRAINING_LOG, ...VALUE_TABLES]) {
      const counts = /* @__PURE__ */ new Map();
      const ids = /* @__PURE__ */ new Map();
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
        if (newId === void 0) {
          const near = norm.get(normalizeName(name));
          if (near && near !== name) {
            this.report.warn(
              `"${name}" (${source.name}) differs from "${near}" only by case/whitespace; kept as a separate entry`
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
    const byParentCorrect = /* @__PURE__ */ new Map();
    for (const child of ROUTINE.children) {
      const groups = /* @__PURE__ */ new Map();
      for (const row of source.rows(child.table)) {
        const parent = row[child.fk];
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push(row);
      }
      byParentCorrect.set(child.table, groups);
    }
    const parents = ["routine", "routine_section", "routine_section_exercise"];
    for (const routine of routines) {
      const name = String(routine[ROUTINE.matchBy]);
      if (this.routineNames.has(name)) {
        this.report.skip(ROUTINE.table);
        this.report.warn(
          `routine "${name}" (${source.name}) already exists in the base file; its sections were not merged`
        );
        continue;
      }
      const built = this.buildValues({ table: ROUTINE.table }, source, routine);
      const routineId = insert(this.db, ROUTINE.table, built.cols, built.values);
      this.routineNames.set(name, routineId);
      this.idMap(source, "routine").set(routine._id, routineId);
      this.report.add(ROUTINE.table);
      let childRows = byParentCorrect.get(ROUTINE.children[0].table)?.get(routine._id) ?? [];
      ROUTINE.children.forEach((child, depth) => {
        const parentEntity = parents[depth];
        const nextRows = [];
        for (const row of childRows) {
          const spec = {
            table: child.table,
            remap: { [child.fk]: parentEntity },
            onUnknownRef: "skip"
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
            nextRows.push(...byParentCorrect.get(ROUTINE.children[depth + 1].table)?.get(row._id) ?? []);
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
    const sourceCounts = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const key = spec.key(row, keys);
      sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
    }
    const state2 = /* @__PURE__ */ new Map();
    for (const [key, total] of sourceCounts) {
      const available = counts?.get(key) ?? 0;
      state2.set(key, { match: Math.min(available, total), inserted: false });
      if (total > available) counts?.set(key, total);
    }
    for (const row of rows) {
      const key = spec.key(row, keys);
      const current = state2.get(key);
      if (current?.match && current.match > 0) {
        current.match -= 1;
        this.report.duplicate(spec.table);
        if (spec.entity && keyToId?.has(key)) {
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
      if (!keyToId?.has(key)) keyToId?.set(key, newId);
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
        this.report.warn(
          `"${table}" differs between ${source.name} and the base file; the base values were kept`
        );
      }
    }
  }
  warnUnsupported(source) {
    for (const table of source.schema.keys()) {
      if (this.coveredTables.has(table) || table.startsWith("sqlite_")) continue;
      const rows = source.rows(table);
      if (!rows.length) continue;
      const baseRows = canonicalRows(all(this.db, table));
      if (!sameRows(canonicalRows(rows), baseRows)) {
        this.report.warn(
          `table "${table}" has ${rows.length} rows in ${source.name} that are not merged yet`
        );
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
};
async function inspectBackup(bytes) {
  let db;
  try {
    db = await openDatabase(new Uint8Array(bytes));
    if (!schema(db).has("training_log") || !schema(db).has("exercise")) {
      throw new Error("not a FitNotes backup (missing tables)");
    }
    const stats = sourceStats(db);
    return {
      ok: true,
      userVersion: userVersion(db),
      sets: stats.sets,
      exercises: stats.exercises,
      firstDate: stats.firstDate ?? "",
      lastDate: stats.lastDate ?? "",
      tables: schema(db).size
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function performanceMemory() {
  if (typeof performance !== "object" || !("memory" in performance)) return void 0;
  return performance.memory;
}
function readMemorySnapshot() {
  const mem = performanceMemory();
  return typeof mem?.usedJSHeapSize === "number" ? mem.usedJSHeapSize : 0;
}
async function mergeBackups(files, options = {}) {
  const { baseIndex, onProgress = () => {
  } } = options;
  if (!Array.isArray(files) || files.length < 2) {
    throw new Error("pass at least two backups to merge");
  }
  const perf = {
    startedAt: performance.now(),
    phases: /* @__PURE__ */ new Map(),
    rowCounts: /* @__PURE__ */ new Map(),
    memorySnapshots: /* @__PURE__ */ new Map()
  };
  const sources = [];
  try {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (!file?.bytes?.length) throw new Error(`file ${i + 1} (${file?.name ?? "?"}) is empty`);
      const phaseStart = performance.now();
      const db = await openDatabase(new Uint8Array(file.bytes));
      sources.push(new Source(i, file.name ?? `file ${i + 1}`, db));
      assertFitNotes(sources[i]);
      perf.phases.set(`open_${i}`, performance.now() - phaseStart);
      onProgress({ phase: "open", index: i, name: sources[i].name });
    }
    validateCompatible(sources);
    const base = Number.isInteger(baseIndex) && baseIndex >= 0 && baseIndex < sources.length ? baseIndex : pickBase(sources);
    const baseSource = sources[base];
    const report = new Report(
      sources.map((source) => ({
        name: source.name,
        ...source.stats,
        userVersion: source.userVersion
      })),
      base
    );
    perf.memorySnapshots.set("before_merge", readMemorySnapshot());
    const merged = await openDatabase(new Uint8Array(files[base].bytes));
    try {
      const mergeStart = performance.now();
      merged.run("BEGIN");
      const context = new MergeContext(merged, report);
      context.prepareBase(baseSource);
      for (const source of sources) {
        for (const table of source.schema.keys()) {
          const current = perf.rowCounts.get(table) ?? 0;
          perf.rowCounts.set(table, current + source.rows(table).length);
        }
      }
      for (const source of sources) {
        if (source.index === base) continue;
        onProgress({ phase: "merge", index: source.index, name: source.name });
        const sourceStart = performance.now();
        context.append(source);
        const sourceDuration = performance.now() - sourceStart;
        perf.phases.set(`merge_${source.index}`, sourceDuration);
        onProgress({ phase: "merged", index: source.index, name: source.name });
      }
      merged.run("COMMIT");
      const mergeDuration = performance.now() - mergeStart;
      perf.phases.set("total_merge", mergeDuration);
      const integrity = integrityCheck(merged);
      if (integrity !== "ok") throw new Error(`merged database failed integrity_check: ${integrity}`);
      const totals = {
        sets: count(merged, "training_log"),
        exercises: count(merged, "exercise")
      };
      onProgress({ phase: "done", ...totals });
      perf.memorySnapshots.set("after_merge", readMemorySnapshot());
      const reportTables = [...report.tables.values()];
      const totalOperations = reportTables.reduce((sum, t) => sum + t.added + t.duplicates + t.skipped, 0);
      const perfSummary = {
        startTime: perf.startedAt,
        totalDuration: performance.now() - perf.startedAt,
        mergeDuration,
        totalOperations,
        operationsPerSecond: mergeDuration > 0 ? totalOperations / (mergeDuration / 1e3) : 0,
        phases: Object.fromEntries(perf.phases),
        rowCounts: Object.fromEntries(perf.rowCounts)
      };
      const beforeMem = perf.memorySnapshots.get("before_merge") ?? 0;
      const afterMem = perf.memorySnapshots.get("after_merge") ?? 0;
      if (beforeMem > 0 || afterMem > 0) {
        perfSummary.memory = {
          before: beforeMem,
          after: afterMem,
          delta: afterMem - beforeMem
        };
      }
      console.log("\u{1F3CB}\uFE0F FitNotes Merger Performance Report");
      console.log("\u2550".repeat(50));
      console.log(`\u23F1  Total time:      ${perfSummary.totalDuration.toFixed(2)} ms`);
      console.log(`\u{1F504}  Merge time:      ${perfSummary.mergeDuration.toFixed(2)} ms`);
      console.log(`\u{1F4CA}  Operations:      ${perfSummary.totalOperations} total`);
      console.log(`\u26A1  Ops/sec:         ${perfSummary.operationsPerSecond.toFixed(1)} ops/s`);
      console.log(`\u{1F4C1}  Files merged:    ${files.length}`);
      console.log(`\u{1F5C4}\uFE0F   Tables touched:  ${perfSummary.rowCounts ? Object.keys(perfSummary.rowCounts).length : "N/A"}`);
      console.log("");
      console.log("Per-file breakdown:");
      for (const source of sources) {
        const phaseTime = perf.phases.get(`merge_${source.index}`) ?? 0;
        console.log(`  ${source.name}:`);
        console.log(`    Sets:        ${source.stats.sets}`);
        console.log(`    Exercises:   ${source.stats.exercises}`);
        console.log(`    Merge time:  ${phaseTime.toFixed(2)} ms`);
      }
      console.log("");
      console.log("Phase timings:");
      for (const [phase, time] of perf.phases) {
        console.log(`  ${phase.padEnd(15)}: ${time.toFixed(2)} ms`);
      }
      if (perfSummary.rowCounts && Object.keys(perfSummary.rowCounts).length > 0) {
        console.log("");
        console.log("Rows processed per table:");
        for (const [table, count2] of Object.entries(perfSummary.rowCounts)) {
          console.log(`  ${table.padEnd(30)}: ${count2.toString().padStart(6)} rows`);
        }
      }
      if (perfSummary.memory) {
        console.log("");
        console.log("Memory usage:");
        console.log(`  Before: ${formatBytes(perfSummary.memory.before)}`);
        console.log(`  After:  ${formatBytes(perfSummary.memory.after)}`);
        console.log(`  Delta:  ${formatBytes(perfSummary.memory.delta)}`);
      }
      console.log("\u2550".repeat(50));
      const resultBaseIndex = base;
      return {
        bytes: merged.export(),
        baseIndex: resultBaseIndex,
        report: report.finish({ integrity, totals }),
        _performance: perfSummary
      };
    } finally {
      merged.close();
    }
  } finally {
    for (const source of sources) {
      try {
        source.close();
      } catch {
      }
    }
  }
}
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

// app.ts
var GYM_TALK = [
  "Chalking up\u2026",
  "Warming up the bar\u2026",
  "Loading plates\u2026",
  "Checking your form\u2026",
  "Counting reps\u2026",
  "Sneaking in a superset\u2026",
  "Hitting depth\u2026",
  "Grinding out the last rep\u2026",
  "Resting for 90 seconds\u2026",
  "Progressive overloading\u2026",
  "Racking the dumbbells\u2026",
  "Wiping down the bench\u2026",
  "Hunting a one-rep max\u2026",
  "Setting the safeties\u2026",
  "Rolling out the DOMS\u2026",
  "Feeding the gains goblin\u2026",
  "Strapping in for a heavy single\u2026",
  "Waiting for the squat rack\u2026",
  "Loading the EZ bar\u2026",
  "Mixing the pre-workout\u2026"
];
var MIN_PROGRESS_MS = 1200;
var el = (id) => document.getElementById(id);
var dom = {
  drop: el("drop"),
  fileInput: el("file-input"),
  pick: el("pick"),
  filesPanel: el("files-panel"),
  fileList: el("file-list"),
  fileCount: el("file-count"),
  merge: el("merge"),
  progressPanel: el("progress-panel"),
  progressBar: el("progress-bar"),
  progressPct: el("progress-pct"),
  progressLabel: el("progress-label"),
  progressQuip: el("progress-quip"),
  resultPanel: el("result-panel"),
  resultSummary: el("result-summary"),
  download: el("download"),
  report: el("report"),
  errorPanel: el("error-panel"),
  errorMessage: el("error-message")
};
var state = {
  files: [],
  base: null,
  busy: false,
  resultUrl: null
};
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var lastQuip = -1;
function nextQuip() {
  let index;
  do {
    index = Math.floor(Math.random() * GYM_TALK.length);
  } while (index === lastQuip && GYM_TALK.length > 1);
  lastQuip = index;
  return GYM_TALK[index];
}
function bestBase() {
  const valid = state.files.filter((file) => file.info.ok);
  return valid.reduce(
    (best, file) => !best || file.info.sets > best.info.sets ? file : best,
    null
  );
}
function renderFiles() {
  const valid = state.files.filter((file) => file.info.ok);
  dom.filesPanel.hidden = state.files.length === 0;
  dom.fileCount.textContent = `${state.files.length} file${state.files.length === 1 ? "" : "s"}`;
  dom.merge.disabled = valid.length < 2 || state.busy;
  dom.fileList.replaceChildren(...state.files.map(fileRow));
}
function fileRow(file) {
  const item = document.createElement("li");
  item.className = `file${file.info.ok ? "" : " invalid"}`;
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "base";
  radio.checked = file === state.base;
  radio.disabled = !file.info.ok || state.busy;
  radio.title = "use as base backup";
  radio.addEventListener("change", () => {
    state.base = file;
    renderFiles();
  });
  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = file.name;
  const meta = document.createElement("span");
  meta.className = "file-meta";
  meta.textContent = file.info.ok ? `${file.info.sets} sets \xB7 ${file.info.exercises} exercises \xB7 ${file.info.firstDate ?? "\u2014"} \u2192 ${file.info.lastDate ?? "\u2014"}` : `not readable \u2014 ${file.info.error}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "\u2715";
  remove.title = "remove file";
  remove.disabled = state.busy;
  remove.addEventListener("click", () => {
    state.files = state.files.filter((candidate) => candidate !== file);
    if (state.base === file) state.base = bestBase();
    renderFiles();
  });
  item.append(radio, name, meta, remove);
  return item;
}
async function addFiles(fileList) {
  if (!fileList?.length) return;
  dom.resultPanel.hidden = true;
  dom.errorPanel.hidden = true;
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = await inspectBackup(bytes);
    state.files.push({ name: file.name, size: file.size, bytes, info });
  }
  if (!state.base || !state.files.includes(state.base) || !state.base.info.ok) {
    state.base = bestBase();
  }
  renderFiles();
}
var quipTimer = null;
function setProgress(fraction) {
  const pct = Math.max(0, Math.min(1, fraction));
  dom.progressBar.style.width = `${(pct * 100).toFixed(1)}%`;
  dom.progressPct.textContent = `${Math.round(pct * 100)}%`;
  dom.progressPanel.querySelector(".progress-track").setAttribute("aria-valuenow", String(Math.round(pct * 100)));
}
function startProgress() {
  clearInterval(quipTimer);
  dom.progressPanel.hidden = false;
  dom.progressPanel.classList.remove("done");
  dom.progressLabel.textContent = "Combobulating your sets\u2026";
  setProgress(0);
  dom.progressQuip.textContent = nextQuip();
  quipTimer = setInterval(() => {
    dom.progressQuip.textContent = nextQuip();
  }, 1500);
}
function finishProgress() {
  clearInterval(quipTimer);
  quipTimer = null;
  setProgress(1);
  dom.progressPanel.classList.add("done");
  dom.progressLabel.textContent = "All reps counted";
  dom.progressQuip.textContent = "Session complete \u2014 merged and re-racked. \u{1F3CB}\uFE0F";
}
function stopProgress() {
  clearInterval(quipTimer);
  quipTimer = null;
  dom.progressPanel.hidden = true;
}
async function runMerge() {
  const valid = state.files.filter((file) => file.info.ok);
  if (state.busy || valid.length < 2) return;
  state.busy = true;
  dom.resultPanel.hidden = true;
  dom.errorPanel.hidden = true;
  renderFiles();
  startProgress();
  const startedAt = performance.now();
  const steps = valid.length - 1;
  let completed = 0;
  try {
    const baseIndex = valid.indexOf(state.base);
    const result = await mergeBackups(
      valid.map(({ name, bytes: data }) => ({ name, bytes: data })),
      {
        baseIndex: baseIndex >= 0 ? baseIndex : void 0,
        onProgress: (event) => {
          if (event.phase === "merged") {
            completed += 1;
            setProgress(completed / steps);
            dom.progressQuip.textContent = nextQuip();
          } else if (event.phase === "done") {
            setProgress(1);
          }
        }
      }
    );
    await sleep(Math.max(0, MIN_PROGRESS_MS - (performance.now() - startedAt)));
    finishProgress();
    await sleep(650);
    showResult(result.bytes, result.report, valid, result._performance);
  } catch (error) {
    stopProgress();
    showError(error);
  } finally {
    state.busy = false;
    renderFiles();
  }
}
function reportTable(rows) {
  const table = document.createElement("table");
  table.className = "report-table";
  const head = document.createElement("tr");
  for (const label of ["Table", "Added", "Duplicates", "Skipped"]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.append(th);
  }
  table.append(head);
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const value of [row.table, row.added, row.duplicates, row.skipped]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    table.append(tr);
  }
  return table;
}
function performancePanel(perf) {
  if (!perf) return null;
  const panel = document.createElement("details");
  panel.className = "perf";
  const summary = document.createElement("summary");
  summary.className = "perf-summary";
  summary.textContent = `Performance details \xB7 ${perf.totalDuration.toFixed(2)} ms total, ${perf.operationsPerSecond.toFixed(1)} ops/s`;
  panel.append(summary);
  const pre = document.createElement("pre");
  pre.className = "perf-body";
  pre.textContent = formatPerformanceText(perf);
  panel.append(pre);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "perf-copy";
  copy.textContent = "Copy stats (JSON)";
  copy.addEventListener("click", () => {
    const payload = JSON.stringify(perf, null, 2);
    if (navigator.clipboard?.writeText && navigator.clipboard.writeText(payload)) {
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.textContent = "Copy stats (JSON)";
      }, 1800);
    } else {
      copy.textContent = "Copy not available";
      setTimeout(() => {
        copy.textContent = "Copy stats (JSON)";
      }, 1800);
    }
  });
  panel.append(copy);
  return panel;
}
function formatPerformanceText(perf) {
  const lines = [];
  lines.push("\u{1F3CB}\uFE0F FitNotes Merger Performance Report");
  lines.push("\u2550".repeat(50));
  lines.push(`\u23F1  Total time:      ${perf.totalDuration.toFixed(2)} ms`);
  lines.push(`\u{1F504}  Merge time:      ${perf.mergeDuration.toFixed(2)} ms`);
  lines.push(`\u{1F4CA}  Operations:      ${perf.totalOperations} total`);
  lines.push(`\u26A1  Ops/sec:         ${perf.operationsPerSecond.toFixed(1)} ops/s`);
  lines.push(`\u{1F4C1}  Files merged:    ${perf.phases["open_0"] ? "see per-file breakdown" : "N/A"}`);
  const sourceCount = Object.keys(perf.phases).filter((key) => key.startsWith("open_")).length;
  lines.push(`\u{1F4C1}  Files merged:    ${sourceCount}`);
  lines.push(`\u{1F5C4}\uFE0F   Tables touched:  ${Object.keys(perf.rowCounts).length}`);
  lines.push("");
  const sources = [...Array(sourceCount).keys()].map((index) => {
    const openKey = `open_${index}`;
    const mergeKey = `merge_${index}`;
    const openTime = perf.phases[openKey] ?? 0;
    const mergeTime = perf.phases[mergeKey] ?? 0;
    return { index, openTime, mergeTime };
  });
  if (sources.length) {
    lines.push("Per-file breakdown:");
    for (const source of sources) {
      const fileIndex = source.index;
      lines.push(`  file ${fileIndex + 1}:`);
      lines.push(`    Open time:   ${source.openTime.toFixed(2)} ms`);
      lines.push(`    Merge time:  ${source.mergeTime.toFixed(2)} ms`);
    }
    lines.push("");
  }
  if (Object.keys(perf.phases).length) {
    lines.push("Phase timings:");
    for (const [phase, time] of Object.entries(perf.phases)) {
      lines.push(`  ${phase.padEnd(15)}: ${Number.isFinite(time) ? time.toFixed(2) : "\u2014"} ms`);
    }
    lines.push("");
  }
  if (Object.keys(perf.rowCounts).length) {
    lines.push("Rows processed per table:");
    for (const [table, count2] of Object.entries(perf.rowCounts)) {
      lines.push(`  ${table.padEnd(30)}: ${String(count2).padStart(6)} rows`);
    }
    lines.push("");
  }
  if (perf.memory) {
    lines.push("Memory usage:");
    lines.push(`  Before: ${formatBytes2(perf.memory.before)}`);
    lines.push(`  After:  ${formatBytes2(perf.memory.after)}`);
    lines.push(`  Delta:  ${formatBytes2(perf.memory.delta)}`);
    lines.push("");
  }
  lines.push("\u2550".repeat(50));
  return lines.join("\n");
}
function showResult(bytes, report, files, perf) {
  const base = files[report.base] ?? files[0];
  dom.resultSummary.textContent = `${report.totals.sets} sets \xB7 ${report.totals.exercises} exercises`;
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  dom.download.onclick = () => {
    const link = document.createElement("a");
    link.href = state.resultUrl;
    link.download = "FitNotes_Backup_merged.fitnotes";
    document.body.append(link);
    link.click();
    link.remove();
  };
  const parts = [];
  const line = document.createElement("p");
  line.className = "result-line";
  line.textContent = `Base: ${base.name} \xB7 integrity check: ${report.integrity} \xB7 ${files.length} files merged \xB7 originals untouched`;
  parts.push(line);
  if (report.tables.length) parts.push(reportTable(report.tables));
  const perfElement = performancePanel(perf);
  if (perfElement) parts.push(perfElement);
  if (report.warnings.length) {
    const heading = document.createElement("h3");
    heading.textContent = "Notes";
    const list = document.createElement("ul");
    list.className = "warnings";
    for (const warning of report.warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      list.append(item);
    }
    parts.push(heading, list);
  }
  dom.report.replaceChildren(...parts);
  dom.resultPanel.hidden = false;
  dom.resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function formatBytes2(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}
function showError(error) {
  dom.errorMessage.textContent = error?.message ?? String(error);
  dom.errorPanel.hidden = false;
  dom.errorPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
dom.merge.addEventListener("click", runMerge);
dom.pick.addEventListener("click", (event) => {
  event.stopPropagation();
  dom.fileInput.click();
});
dom.drop.addEventListener("click", (event) => {
  if (event.target.closest("button")) return;
  dom.fileInput.click();
});
dom.drop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    dom.fileInput.click();
  }
});
dom.fileInput.addEventListener("change", () => {
  addFiles(dom.fileInput.files);
  dom.fileInput.value = "";
});
for (const type of ["dragenter", "dragover"]) {
  dom.drop.addEventListener(type, (event) => {
    event.preventDefault();
    dom.drop.classList.add("drag");
  });
}
for (const type of ["dragleave", "dragend"]) {
  dom.drop.addEventListener(type, () => dom.drop.classList.remove("drag"));
}
dom.drop.addEventListener("drop", (event) => {
  event.preventDefault();
  dom.drop.classList.remove("drag");
  addFiles(event.dataTransfer?.files);
});
