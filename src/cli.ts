#!/usr/bin/env node
/**
 * CLI for the FitNotes merger. Uses the exact same core as the website.
 *
 * Usage:
 *   node src/cli.ts -o merged.fitnotes backup-1.fitnotes backup-2.fitnotes [...]
 *
 * Options:
 *   -o, --out <file>   output file (required)
 *       --base <file>  file whose settings/plates win (default: most sets)
 *       --dry-run      run the merge without writing the output file
 *       --json         print the merge report as JSON on stdout
 *   -h, --help         show this help
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { mergeBackups, type ProgressEvent } from './core/merge.js';

function usage(): void {
  console.log(`Usage: fitnotes-merge -o merged.fitnotes backup-1.fitnotes backup-2.fitnotes [...]

Options:
  -o, --out <file>   output file (required)
      --base <file>  file whose settings/plates win (default: most sets)
      --dry-run      run the merge without writing the output file
      --json         print the merge report as JSON on stdout
  -h, --help         show this help`);
}

const args = process.argv.slice(2);
let out: string | null = null;
let baseName: string | null = null;
let dryRun = false;
let json = false;
const inputs: string[] = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '-o' || arg === '--out') out = args[(i += 1)];
  else if (arg === '--base') baseName = args[(i += 1)];
  else if (arg === '--dry-run') dryRun = true;
  else if (arg === '--json') json = true;
  else if (arg === '-h' || arg === '--help') {
    usage();
    process.exit(0);
  } else if (arg.startsWith('-')) {
    console.error(`unknown option: ${arg}\n`);
    usage();
    process.exit(2);
  } else {
    inputs.push(arg);
  }
}

if (!out || inputs.length < 2) {
  usage();
  process.exit(2);
}

const files = inputs.map((path) => ({
  name: basename(path),
  path,
  bytes: new Uint8Array(readFileSync(path)),
}));

let baseIndex: number | undefined;
if (baseName) {
  baseIndex = files.findIndex((file) => file.name === baseName);
  if (baseIndex < 0) {
    console.error(`--base ${baseName}: not among the input files`);
    process.exit(2);
  }
}

/** Prints per-file progress to stderr so stdout stays clean, especially with --json. */
function progress(event: ProgressEvent): void {
  if (event.index === undefined || !event.name) return;
  if (event.phase === 'open') console.error(`[${event.index + 1}/${files.length}] opening ${event.name}`);
  else if (event.phase === 'merge') console.error(`[${event.index + 1}/${files.length}] merging ${event.name}`);
}

try {
  const { bytes, report } = await mergeBackups(files, { baseIndex, onProgress: progress, logStats: !json });
  if (!dryRun) writeFileSync(out, Buffer.from(bytes));

  if (json) {
    console.log(JSON.stringify({ out, dryRun, report }));
  } else {
    console.log(
      dryRun
        ? `Dry run: merged ${files.length} backups -> ${out} (nothing written)`
        : `Merged ${files.length} backups -> ${out}`,
    );
    console.log(`base: ${report.files[report.base].name} (${report.files[report.base].sets} sets)\n`);

    const rows = report.tables.map((t) => [t.table, String(t.added), String(t.duplicates), String(t.skipped)]);
    const header = ['table', 'added', 'duplicates', 'skipped'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
    if (rows.length) {
      console.log(line(header));
      for (const row of rows) console.log(line(row));
      console.log('');
    }

    for (const warning of report.warnings) console.log(`warning: ${warning}`);
    if (report.warnings.length) console.log('');

    const span = report.files.reduce(
      (acc, file) => [
        [acc[0], file.firstDate].filter(Boolean).sort()[0] ?? null,
        [acc[1], file.lastDate].filter(Boolean).sort().at(-1) ?? null,
      ],
      [null as string | null, null as string | null] as [string | null, string | null],
    );
    console.log(
      `result: integrity ${report.integrity}, ${report.totals.sets} sets, ` +
        `${report.totals.exercises} exercises, ${span[0] ?? '—'} .. ${span[1] ?? '—'}`,
    );
  }
} catch (error: unknown) {
  console.error(`error: ${(error as Error)?.message ?? error}`);
  process.exit(1);
}
