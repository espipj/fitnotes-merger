/** End-to-end tests for the CLI: args, exit codes, progress, JSON output and the written file. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBackup, category, exercise, workoutSet } from './helpers.js';
import { openDatabase } from '../src/core/sqlite.js';
import { integrityCheck } from '../src/core/db.js';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

type Cleanup = { after(fn: () => void): void };

/** Runs the CLI in a child process with tsx loaded, from the repo root. */
function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8' });
}

/** Makes a temp directory that is removed when the test finishes. */
function tempDir(t: Cleanup): string {
  const dir = mkdtempSync(join(tmpdir(), 'fitnotes-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes a synthetic backup to `dir` and returns its path. */
async function writeBackup(dir: string, name: string, seed: Record<string, Record<string, unknown>[]>): Promise<string> {
  const path = join(dir, name);
  writeFileSync(path, await buildBackup(seed));
  return path;
}

const openChest = { Category: [category('Chest', 1)], exercise: [exercise('Bench Press', 1, 1)] };

test('--help exits 0 and prints usage', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: fitnotes-merge/);
});

test('unknown options exit 2', () => {
  const result = runCli(['--nope']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option: --nope/);
});

test('a missing -o or fewer than two inputs exits 2', () => {
  const result = runCli(['a.fitnotes', 'b.fitnotes']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Usage: fitnotes-merge/);
});

test('--base with a name outside the inputs exits 2', async (t) => {
  const dir = tempDir(t);
  const a = await writeBackup(dir, 'a.fitnotes', openChest);
  const b = await writeBackup(dir, 'b.fitnotes', openChest);

  const result = runCli(['-o', join(dir, 'out.fitnotes'), '--base', 'c.fitnotes', a, b]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not among the input files/);
});

test('merges two backups, reports progress and writes a valid result', async (t) => {
  const dir = tempDir(t);
  const a = await writeBackup(dir, 'a.fitnotes', {
    ...openChest,
    training_log: [workoutSet(1, '2026-01-10', 1)],
  });
  const b = await writeBackup(dir, 'b.fitnotes', {
    ...openChest,
    training_log: [workoutSet(1, '2026-02-01', 1)],
  });
  const out = join(dir, 'merged.fitnotes');

  const result = runCli(['-o', out, a, b]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /result: integrity ok/);
  assert.match(result.stderr, /\[2\/2\] merging b\.fitnotes/);
  assert.ok(existsSync(out));

  const db = await openDatabase(new Uint8Array(readFileSync(out)));
  try {
    assert.equal(integrityCheck(db), 'ok');
  } finally {
    db.close();
  }
});

test('--dry-run reports the merge without writing the output', async (t) => {
  const dir = tempDir(t);
  const a = await writeBackup(dir, 'a.fitnotes', openChest);
  const b = await writeBackup(dir, 'b.fitnotes', openChest);
  const out = join(dir, 'merged.fitnotes');

  const result = runCli(['--dry-run', '-o', out, a, b]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Dry run/);
  assert.equal(existsSync(out), false);
});

test('--json prints the report as parseable JSON', async (t) => {
  const dir = tempDir(t);
  const a = await writeBackup(dir, 'a.fitnotes', {
    ...openChest,
    training_log: [workoutSet(1, '2026-01-10', 1)],
  });
  const b = await writeBackup(dir, 'b.fitnotes', {
    Category: [category('Chest', 1), category('Back', 2)],
    exercise: [exercise('Bench Press', 1, 1), exercise('Row', 2, 2)],
    training_log: [workoutSet(2, '2026-02-01', 1)],
  });
  const out = join(dir, 'merged.fitnotes');

  const result = runCli(['--json', '-o', out, a, b]);
  assert.equal(result.status, 0);

  const payload = JSON.parse(result.stdout) as {
    out: string;
    dryRun: boolean;
    report: { integrity: string; totals: { sets: number } };
  };
  assert.equal(payload.out, out);
  assert.equal(payload.dryRun, false);
  assert.equal(payload.report.integrity, 'ok');
  assert.equal(payload.report.totals.sets, 2);
  assert.ok(existsSync(out));
});
