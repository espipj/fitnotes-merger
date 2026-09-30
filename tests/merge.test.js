import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBackup, category, exercise, workoutSet, emptyDatabase } from './helpers.js';
import { inspectBackup, mergeBackups } from '../src/core/merge.js';
import { openDatabase } from '../src/core/sqlite.js';
import { count, insert, integrityCheck, run, select } from '../src/core/db.js';

async function withDb(bytes, fn) {
  const db = await openDatabase(new Uint8Array(bytes));
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

const openChest = { Category: [category('Chest', 1)], exercise: [exercise('Bench Press', 1, 1)] };

test('merges disjoint histories and remaps ids by exercise name', async () => {
  const a = await buildBackup({
    ...openChest,
    training_log: [workoutSet(1, '2026-01-10', 1, { metric_weight: 100, reps: 5 })],
  });
  const b = await buildBackup({
    Category: [category('Chest', 1), category('Back', 2)],
    exercise: [exercise('Bench Press', 1, 1), exercise('Row', 2, 2)],
    training_log: [workoutSet(2, '2026-02-01', 1, { metric_weight: 80, reps: 8 })],
  });

  const { bytes, report } = await mergeBackups([{ name: 'a', bytes: a }, { name: 'b', bytes: b }], { baseIndex: 0 });

  assert.equal(report.integrity, 'ok');
  assert.equal(report.totals.sets, 2);
  assert.deepEqual(
    report.tables.find((t) => t.table === 'exercise'),
    { table: 'exercise', added: 1, duplicates: 0, skipped: 0 },
  );

  await withDb(bytes, (db) => {
    const rows = select(db, `SELECT e.name FROM training_log t JOIN exercise e ON e._id = t.exercise_id ORDER BY t.date`);
    assert.deepEqual(rows.map((r) => r.name), ['Bench Press', 'Row']);
    const rowExercise = select(db, `SELECT e.category_id FROM exercise e WHERE e.name = 'Row'`)[0];
    const back = select(db, `SELECT _id FROM Category WHERE name = 'Back'`)[0];
    assert.equal(rowExercise.category_id, back._id);
  });
});

test('a set present in several backups is kept once (max, not sum)', async () => {
  const theSet = workoutSet(1, '2026-03-01', 1, { metric_weight: 60, reps: 10 });
  const a = await buildBackup({ ...openChest, training_log: [theSet] });
  const b = await buildBackup({
    ...openChest,
    training_log: [workoutSet(1, '2026-03-01', 1, { metric_weight: 60, reps: 10 })],
  });

  const merged = await mergeBackups([{ name: 'a', bytes: a }, { name: 'b', bytes: b }]);
  assert.equal(merged.report.totals.sets, 1);
  assert.equal(merged.report.tables.find((t) => t.table === 'training_log').duplicates, 1);

  const reversed = await mergeBackups([{ name: 'b', bytes: b }, { name: 'a', bytes: a }], { baseIndex: 0 });
  assert.equal(reversed.report.totals.sets, 1);
});

test('identical sets logged twice on purpose stay twice', async () => {
  const a = await buildBackup({
    ...openChest,
    training_log: [workoutSet(1, '2026-03-02', 1), workoutSet(1, '2026-03-02', 2)],
  });
  const b = await buildBackup({ ...openChest, training_log: [workoutSet(1, '2026-03-02', 1)] });

  const { report } = await mergeBackups([{ name: 'a', bytes: a }, { name: 'b', bytes: b }]);
  assert.equal(report.totals.sets, 2);
});

test('three backups merge to the same maximum, whichever is the base', async () => {
  const mk = () => buildBackup({ ...openChest, training_log: [workoutSet(1, '2026-04-01', 1)] });
  const [a, b, c] = await Promise.all([mk(), mk(), mk()]);

  const forward = await mergeBackups([{ name: 'a', bytes: a }, { name: 'b', bytes: b }, { name: 'c', bytes: c }]);
  assert.equal(forward.report.totals.sets, 1);

  const backward = await mergeBackups(
    [{ name: 'c', bytes: c }, { name: 'b', bytes: b }, { name: 'a', bytes: a }],
    { baseIndex: 2 },
  );
  assert.equal(backward.report.totals.sets, 1);
});

test('routines are copied wholesale by name; existing ones are skipped with a warning', async () => {
  const push = {
    Routine: [{ _id: 1, name: 'Push', notes: null }],
    RoutineSection: [{ _id: 1, routine_id: 1, name: 'A', sort_order: 0 }],
    RoutineSectionExercise: [{ _id: 1, routine_section_id: 1, exercise_id: 1, sort_order: 0, populate_sets_type: 0 }],
    RoutineSectionExerciseSet: [{
      _id: 1, routine_section_exercise_id: 1, metric_weight: 60, reps: 5,
      sort_order: 0, distance: 0, duration_seconds: 0, unit: 0,
    }],
  };
  const a = await buildBackup({ ...openChest, ...push });
  const b = await buildBackup({
    Category: [category('Chest', 1)],
    exercise: [exercise('Bench Press', 1, 1)],
    Routine: [
      { _id: 1, name: 'Push', notes: 'already there' },
      { _id: 2, name: 'Legs', notes: null },
    ],
    RoutineSection: [
      { _id: 1, routine_id: 1, name: 'A', sort_order: 0 },
      { _id: 2, routine_id: 2, name: 'B', sort_order: 0 },
    ],
    RoutineSectionExercise: [
      { _id: 1, routine_section_id: 2, exercise_id: 1, sort_order: 0, populate_sets_type: 0 },
    ],
    RoutineSectionExerciseSet: [{
      _id: 1, routine_section_exercise_id: 1, metric_weight: 40, reps: 12,
      sort_order: 0, distance: 0, duration_seconds: 0, unit: 0,
    }],
  });

  const { bytes, report } = await mergeBackups([{ name: 'a', bytes: a }, { name: 'b', bytes: b }], { baseIndex: 0 });

  assert.equal(report.tables.find((t) => t.table === 'Routine').added, 1);
  assert.ok(report.warnings.some((w) => w.includes('"Push"')), 'expected a warning about the existing routine');
  await withDb(bytes, (db) => {
    assert.deepEqual(select(db, 'SELECT name FROM Routine ORDER BY name').map((r) => r.name), ['Legs', 'Push']);
    const setRow = select(db, `SELECT s.metric_weight, e.name AS exercise
      FROM RoutineSectionExerciseSet s
      JOIN RoutineSectionExercise rse ON rse._id = s.routine_section_exercise_id
      JOIN RoutineSection rs ON rs._id = rse.routine_section_id
      JOIN Routine r ON r._id = rs.routine_id
      JOIN exercise e ON e._id = rse.exercise_id
      WHERE r.name = 'Legs'`)[0];
    assert.equal(setRow.exercise, 'Bench Press');
    assert.equal(setRow.metric_weight, 40);
  });
});

test('catalog tables keep the base values and warn on differences', async () => {
  const plate = (weight) => ({
    _id: 1, weight, unit: 0, count: 2, enabled: 1, colour: 0, width_ratio: 1, height_ratio: 1,
  });
  const a = await buildBackup({ ...openChest, Plate: [plate(20)] });
  const b = await buildBackup({ ...openChest, Plate: [plate(45)] });

  const { bytes, report } = await mergeBackups([{ name: 'a', bytes: a }, { name: 'b', bytes: b }]);
  assert.ok(report.warnings.some((w) => w.includes('Plate')));
  await withDb(bytes, (db) => {
    assert.equal(count(db, 'Plate'), 1);
    assert.equal(select(db, 'SELECT weight FROM Plate')[0].weight, 20);
  });
});

test('rows referencing an unknown exercise are skipped with a warning', async () => {
  const a = await buildBackup({ ...openChest, training_log: [workoutSet(1, '2026-05-01', 1)] });
  const b = await buildBackup({
    ...openChest,
    training_log: [workoutSet(999, '2026-05-02', 1)],
  });

  const { bytes, report } = await mergeBackups([{ name: 'a', bytes: a }, { name: 'b', bytes: b }]);
  assert.equal(report.totals.sets, 1);
  assert.equal(report.tables.find((t) => t.table === 'training_log').skipped, 1);
  assert.ok(report.warnings.some((w) => w.includes('unknown exercise')));
  await withDb(bytes, (db) => {
    assert.equal(integrityCheck(db), 'ok');
  });
});

test('refuses backups with different schema versions', async () => {
  const a = await buildBackup({ ...openChest, training_log: [workoutSet(1, '2026-06-01', 1)] });

  const old = await emptyDatabase();
  const seed = {
    Category: [category('Chest', 1)],
    exercise: [exercise('Bench Press', 1, 1)],
    training_log: [workoutSet(1, '2026-06-02', 1)],
  };
  for (const [table, rows] of Object.entries(seed)) {
    for (const row of rows) insert(old, table, Object.keys(row), Object.values(row));
  }
  run(old, 'PRAGMA user_version = 21');
  const b = old.export();
  old.close();

  await assert.rejects(
    () => mergeBackups([{ name: 'a', bytes: a }, { name: 'b', bytes: b }]),
    /not compatible|schema versions/,
  );
});

test('inspectBackup reports stats and rejects non-backups', async () => {
  const a = await buildBackup({ ...openChest, training_log: [workoutSet(1, '2026-07-01', 1)] });
  const info = await inspectBackup(a);
  assert.equal(info.ok, true);
  assert.equal(info.sets, 1);
  assert.equal(info.userVersion, 22);
  assert.equal(info.firstDate, '2026-07-01');

  const garbage = await inspectBackup(new Uint8Array([1, 2, 3, 4]));
  assert.equal(garbage.ok, false);
  assert.ok(garbage.error);
});
