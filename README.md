# FitNotes Merger

Merge any number of [FitNotes](http://www.fitnotesapp.com/) `.fitnotes` backups into one —
as a website (100% in-browser, SQLite compiled to WebAssembly), a CLI, or a library.

> **Live demo:** https://espipj.github.io/fitnotes-merger/ — drop your backups, get one file back.
> Nothing is uploaded: the page runs SQLite in your browser and never talks to a server.

## Why this works

A `.fitnotes` backup is not a proprietary blob — it is a plain SQLite database
(`FitNotes_Backup.fitnotes`) with the app's tables inside. FitNotes itself only imports a
backup by *replacing* everything on the phone, so moving history from two phones or merging
an old backup into a new one means merging the databases.

This project does that merge with well-defined rules:

| Data | Rule |
| --- | --- |
| Workout sets (`training_log`) | union; a set present in several backups is kept **once** (counts merge as `max`, not sum), while sets logged twice on purpose stay twice |
| Exercises & categories | matched **by name**, ids rewired; missing ones are added with their category |
| Routines | copied wholesale (sections → exercises → sets) when the name is new; existing routines are left untouched |
| Body weight, measurements, goals, workout notes/times | union; exact duplicates dropped |
| Settings, plates, units, locale | always taken from the **base** file; differences are reported |

The result is verified with `PRAGMA integrity_check` before it is handed back.

## Website

1. On the phone, open FitNotes → Settings → Backup. Do it on **every** device whose history
   you want, and keep the files safe.
2. Open the [website](https://espipj.github.io/fitnotes-merger/) and drop the files in.
   Pick one as the *base* (its settings and plates win); the biggest is chosen by default.
3. Download `FitNotes_Backup_merged.fitnotes`, copy it to the phone and open it — FitNotes
   offers *Copy to FitNotes*.

> ⚠️ Importing a backup **overwrites** the data on the phone. Take a fresh backup first, so
> nothing is lost if you change your mind.

## CLI

```bash
npm install
node src/cli.js -o merged.fitnotes backup-old.fitnotes backup-new.fitnotes [more.fitnotes ...]

# optional: choose which file supplies settings/plates
node src/cli.js --base backup-new.fitnotes -o merged.fitnotes backup-old.fitnotes backup-new.fitnotes
```

It prints a per-table report of added/duplicate/skipped rows and any warnings.

## Library

```js
import { readFileSync } from 'node:fs';
import { mergeBackups } from './src/core/merge.js';

const files = ['a.fitnotes', 'b.fitnotes'].map((path) => ({
  name: path,
  bytes: new Uint8Array(readFileSync(path)),
}));

const { bytes, report } = await mergeBackups(files);
// bytes: Uint8Array of the merged SQLite database
// report: { integrity, totals, tables: [{table, added, duplicates, skipped}], warnings }
```

`mergeBackups(files, { baseIndex })` accepts any number of files (2+). `inspectBackup(bytes)`
returns `{ ok, sets, exercises, firstDate, lastDate, userVersion }` for previews.

## Development

```bash
npm install
npm test          # unit tests; see below for the real-backup integration test

# run the website locally (ES modules and the wasm need http, not file://)
python3 -m http.server 4173
# then open http://localhost:4173/
```

Integration test against real backups (paths never committed):

```bash
FITNOTES_MERGE_FILES="$HOME/a.fitnotes:$HOME/b.fitnotes" npm test
```

### Layout

```
index.html app.js style.css    website (GitHub Pages root)
vendor/                        sql.js + SQLite wasm, vendored (no CDN)
src/core/sqlite.js             loads sql.js in browser and Node
src/core/db.js                 small helpers over a SQLite handle
src/core/adapters.js           declarative per-table merge rules
src/core/merge.js              engine + report
src/cli.js                     CLI using the same core
tests/                         node:test unit tests + fixtures
```

Adding support for a new FitNotes table (or a new schema version) means adding an entry in
`src/core/adapters.js` — the engine does not know about individual tables.

## Caveats

- FitNotes is closed source; the schema here was reverse-engineered from real backups
  (SQLite `user_version` **22**). Merging files with different versions is refused.
- Personal-record flags are carried over verbatim; FitNotes may not recompute them until
  new entries are logged.
- A few rarely used tables (`Comment` owner ids, favourites) are copied best-effort; the
  report tells you when that happens.
- Always keep your original backups until the merged one is restored and verified.

Not affiliated with FitNotes. MIT licensed.
