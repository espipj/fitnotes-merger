/**
 * Integration test against real backups.
 *
 * Only runs when FITNOTES_MERGE_FILES is set to two or more colon-separated
 * paths. Personal backups never live in this repository:
 *
 *   FITNOTES_MERGE_FILES="$HOME/a.fitnotes:$HOME/b.fitnotes" npm test
 *
 * The expected result is computed independently: every set is identified by
 * its value key, and a key's count in the result must be the maximum count
 * across the input files.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { mergeBackups } from '../src/core/merge.js';
import { openDatabase } from '../src/core/sqlite.js';
import { count, select } from '../src/core/db.js';

const paths = (process.env.FITNOTES_MERGE_FILES ?? '').split(':').filter(Boolean);

async function setCounts(bytes: Uint8Array): Promise<Map<string, number>> {
  const db = await openDatabase(new Uint8Array(bytes));
  try {
    const names = new Map(select(db, 'SELECT _id, name FROM exercise').map((row) => [row._id as number, row.name as string]));
    const counts = new Map<string, number>();
    for (const row of select(db, 'SELECT * FROM training_log')) {
      const key = JSON.stringify([
        row.date,
        names.get(row.exercise_id as number) ?? `?${row.exercise_id}`,
        row.metric_weight,
        row.reps,
        row.unit,
        row.distance,
        row.duration_seconds,
      ]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  } finally {
    db.close();
  }
}

test('real backups merge to the expected union', {
  skip: paths.length < 2 ? 'set FITNOTES_MERGE_FILES=a.fitnotes:b.fitnotes[:...]' : false,
}, async () => {
  const files = paths.map((path) => ({ name: basename(path), bytes: new Uint8Array(readFileSync(path)) }));
  const { bytes, report } = await mergeBackups(files);

  assert.equal(report.integrity, 'ok');
  assert.equal(report.tables.find((t) => t.table === 'training_log')?.skipped ?? 0, 0);

  const perFile = await Promise.all(files.map((file) => setCounts(file.bytes)));
  const expected = new Map<string, number>();
  for (const counts of perFile) {
    for (const [key, value] of counts) {
      expected.set(key, Math.max(expected.get(key) ?? 0, value));
    }
  }
  const expectedTotal = [...expected.values()].reduce((sum, value) => sum + value, 0);

  const merged = await openDatabase(new Uint8Array(bytes));
  try {
    assert.equal(count(merged, 'training_log'), expectedTotal);
  } finally {
    merged.close();
  }

  const mergedCounts = await setCounts(bytes);
  for (const [key, value] of expected) {
    assert.equal(mergedCounts.get(key), value, `set count mismatch for ${key}`);
  }
  console.log(`    merged ${files.length} files -> ${expectedTotal} sets`);
});
