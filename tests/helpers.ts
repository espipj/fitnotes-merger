/** Builds synthetic FitNotes backups for the tests, using the real schema. */

import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/core/sqlite.js';
import { insert, run } from '../src/core/db.js';

const rawSchema = readFileSync(new URL('./fixtures/schema.sql', import.meta.url), 'utf8');
const STATEMENTS = rawSchema
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

/** Opens an empty database with the FitNotes schema (user_version 22). */
export async function emptyDatabase() {
  const db = await openDatabase();
  for (const statement of STATEMENTS) run(db, statement);
  run(db, 'PRAGMA user_version = 22');
  return db;
}

/** Builds a backup byte array from `{ table: [rows] }`. */
export async function buildBackup(seed: Record<string, Record<string, unknown>[]> = {}) {
  const db = await emptyDatabase();
  for (const [table, rows] of Object.entries(seed)) {
    for (const row of rows) {
      insert(db, table, Object.keys(row), Object.values(row));
    }
  }
  return db.export();
}

/** Convenience row builders. */
export function category(name: string, id: number): { _id: number; name: string; colour: number; sort_order: number } {
  return { _id: id, name, colour: 0, sort_order: id };
}

export function exercise(
  name: string,
  categoryId: number,
  id: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: id,
    name,
    category_id: categoryId,
    exercise_type_id: 0,
    notes: null,
    weight_increment: null,
    default_graph_id: null,
    default_rest_time: null,
    weight_unit_id: 0,
    is_favourite: 0,
    ...extra,
  };
}

export function workoutSet(
  exerciseId: number,
  date: string,
  id: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: id,
    exercise_id: exerciseId,
    date,
    metric_weight: 50,
    reps: 5,
    unit: 0,
    routine_section_exercise_set_id: 0,
    timer_auto_start: 0,
    is_personal_record: 0,
    is_personal_record_first: 0,
    is_complete: 1,
    is_pending_update: 0,
    distance: 0,
    duration_seconds: 0,
    ...extra,
  };
}
