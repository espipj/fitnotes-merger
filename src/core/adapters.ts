/**
 * Table adapters — every table-specific merge rule lives here.
 *
 * The engine in merge.js knows nothing about individual tables. Adding
 * support for a new FitNotes table (or a new schema version) means adding an
 * entry below, not touching the engine.
 *
 * Adapter kinds:
 *   entity   rows matched by a natural key (name); their ids are remapped for
 *            every other row that references them
 *   routine  routines copied wholesale (sections -> exercises -> sets), by name
 *   value    rows matched by a `key(row, name)`; referenced ids remapped via
 *            `remap`; a `key` must be equal for the same logical row in any file
 *   static   catalog/config tables where the base file wins; differences warned
 *
 * `remap` maps a column to an entity whose old->new id map is applied.
 * `remapOptional` maps a column like `remap` but falls back when unknown
 * (used for references that may legitimately be 0 / dangling across files).
 * `remapList` is like `remap` for comma-separated id lists.
 */

import type { DbRow } from './db.js';

/** Rows joined by name; the resulting maps are used by every `remap`. */
export const ENTITIES: EntityAdapter[] = [
  { entity: 'category', table: 'Category', matchBy: 'name' },
  {
    entity: 'exercise',
    table: 'exercise',
    matchBy: 'name',
    remap: { category_id: 'category' },
    onUnknownRef: 'keep',
  },
  { entity: 'measurement', table: 'Measurement', matchBy: 'name' },
];

/** Routines are copied as a tree, matched by name. */
export const ROUTINE: RoutineAdapter = {
  table: 'Routine',
  matchBy: 'name',
  children: [
    { table: 'RoutineSection', fk: 'routine_id', entity: 'routine_section' },
    {
      table: 'RoutineSectionExercise',
      fk: 'routine_section_id',
      entity: 'routine_section_exercise',
      remap: { exercise_id: 'exercise' },
    },
    {
      table: 'RoutineSectionExerciseSet',
      fk: 'routine_section_exercise_id',
      entity: 'routine_section_exercise_set',
    },
  ],
};

/**
 * The workout history. Deduplicated as a multiset over the set's values so
 * that a set logged twice on purpose is kept twice, while a set present in
 * several backups is only kept once.
 */
export const TRAINING_LOG: ValueAdapter = {
  table: 'training_log',
  remap: { exercise_id: 'exercise' },
  onUnknownRef: 'skip',
  remapOptional: { routine_section_exercise_set_id: { entity: 'routine_section_exercise_set', fallback: 0 } },
  key: (row, name) => JSON.stringify([
    row.date,
    name('exercise', row.exercise_id),
    row.metric_weight,
    row.reps,
    row.unit,
    row.distance,
    row.duration_seconds,
  ]),
};

/** Everything else that carries user data, in dependency order. */
export const VALUE_TABLES: ValueAdapter[] = [
  {
    table: 'Barbell',
    remap: { exercise_id: 'exercise' },
    key: (row, name) => JSON.stringify([name('exercise', row.exercise_id), row.weight, row.unit]),
  },
  {
    table: 'BodyWeight',
    key: (row) => JSON.stringify([row.date, row.body_weight_metric, row.body_fat, row.comments]),
  },
  {
    table: 'Goal',
    remap: { exercise_id: 'exercise' },
    key: (row, name) => JSON.stringify([
      name('exercise', row.exercise_id), row.type_id, row.metric_weight, row.reps,
      row.unit, row.title, row.target_date, row.sort_order, row.distance,
      row.duration_seconds, row.start_date,
    ]),
  },
  {
    table: 'MeasurementRecord',
    remap: { measurement_id: 'measurement' },
    key: (row, name) => JSON.stringify([
      name('measurement', row.measurement_id), row.date, row.time, row.value, row.comment,
    ]),
  },
  {
    table: 'Comment',
    note: 'owner ids are copied as-is (owner_type_id is polymorphic)',
    key: (row) => JSON.stringify([row.date, row.owner_type_id, row.owner_id, row.comment]),
  },
  {
    table: 'WorkoutComment',
    key: (row) => JSON.stringify([row.date, row.comment]),
  },
  {
    table: 'WorkoutTime',
    key: (row) => JSON.stringify([row.workout_date, row.start_date_time, row.end_date_time]),
  },
  {
    table: 'WorkoutGroup',
    entity: 'workout_group',
    remapOptional: { routine_section_id: { entity: 'routine_section', fallback: null } },
    key: (row, name) => JSON.stringify([
      name('routine_section', row.routine_section_id), row.name, row.date, row.colour,
      row.auto_jump_enabled, row.rest_timer_auto_start_enabled,
    ]),
  },
  {
    table: 'WorkoutGroupExercise',
    remap: { exercise_id: 'exercise' },
    remapOptional: {
      routine_section_id: { entity: 'routine_section', fallback: null },
      workout_group_id: { entity: 'workout_group', fallback: 0 },
    },
    key: (row, name) => JSON.stringify([
      name('exercise', row.exercise_id), row.date, name('workout_group', row.workout_group_id),
    ]),
  },
  {
    table: 'ExerciseGraphFavourite',
    remap: { exercise_id: 'exercise' },
    note: 'group_id is copied without remapping',
    key: (row, name) => JSON.stringify([
      row.group_id, name('exercise', row.exercise_id), row.graph_type_id,
      row.time_period, row.sort_order, row.is_default,
    ]),
  },
  {
    table: 'RepMaxGridFavourite',
    remapList: { exercise_ids: 'exercise' },
    note: 'exercise_ids is treated as a comma-separated id list',
    key: (row, name) => JSON.stringify([
      name.list('exercise', row.exercise_ids), row.rep_counts, row.is_default, row.sort_order,
    ]),
  },
];

/** Catalog/config tables: the base file always wins, differences are warned. */
export const STATIC_TABLES = ['settings', 'MeasurementUnit', 'Plate', 'android_metadata'];

// ---------------------------------------------------------------------------

type RemapSpec = Record<string, string>;
type RemapOptionalSpec = Record<string, { entity: string; fallback: number | null }>;
type RemapListSpec = Record<string, string>;

export interface EntityAdapter {
  entity: string;
  table: string;
  matchBy: string;
  remap?: RemapSpec;
  onUnknownRef?: 'skip' | 'keep';
}

export interface RoutineAdapter {
  table: string;
  matchBy: string;
  children: {
    table: string;
    fk: string;
    entity: string;
    remap?: RemapSpec;
  }[];
}

export interface ValueAdapter {
  table: string;
  entity?: string;
  matchBy?: never;
  remap?: RemapSpec;
  remapOptional?: RemapOptionalSpec;
  remapList?: RemapListSpec;
  onUnknownRef?: 'skip' | 'keep';
  note?: string;
  key: (row: DbRow, name: NameFn) => string;
}

type NameFn = (
  entity: string,
  value: number | string | null | undefined,
) => string;

declare module './merge.js' {
  // Re-export for merge.js consumers
  export {
    ENTITIES,
    ROUTINE,
    TRAINING_LOG,
    VALUE_TABLES,
    STATIC_TABLES,
    type EntityAdapter,
    type RoutineAdapter,
    type ValueAdapter,
  };
}
