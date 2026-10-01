/**
 * Web UI. All merging happens in the browser through the shared core in
 * src/core/ — this file only handles files, progress and presentation.
 */

import { inspectBackup, mergeBackups, type MergeReport, type ProgressEvent } from './src/core/merge.ts';

/* Gym-flavoured status lines shown under the progress bar while merging. */
const GYM_TALK: string[] = [
  'Chalking up…',
  'Warming up the bar…',
  'Loading plates…',
  'Checking your form…',
  'Counting reps…',
  'Sneaking in a superset…',
  'Hitting depth…',
  'Grinding out the last rep…',
  'Resting for 90 seconds…',
  'Progressive overloading…',
  'Racking the dumbbells…',
  'Wiping down the bench…',
  'Hunting a one-rep max…',
  'Setting the safeties…',
  'Rolling out the DOMS…',
  'Feeding the gains goblin…',
  'Strapping in for a heavy single…',
  'Waiting for the squat rack…',
  'Loading the EZ bar…',
  'Mixing the pre-workout…',
];

const MIN_PROGRESS_MS = 1200;

const el = (id: string): HTMLElement | null => document.getElementById(id);

const dom = {
  drop: el('drop')!,
  fileInput: el('file-input') as HTMLInputElement,
  pick: el('pick')!,
  filesPanel: el('files-panel')!,
  fileList: el('file-list')!,
  fileCount: el('file-count')!,
  merge: el('merge') as HTMLButtonElement,
  progressPanel: el('progress-panel')!,
  progressBar: el('progress-bar')!,
  progressPct: el('progress-pct')!,
  progressLabel: el('progress-label')!,
  progressQuip: el('progress-quip')!,
  resultPanel: el('result-panel')!,
  resultSummary: el('result-summary')!,
  download: el('download') as HTMLButtonElement,
  report: el('report')!,
  errorPanel: el('error-panel')!,
  errorMessage: el('error-message')!,
};

interface FileState {
  name: string;
  size: number;
  bytes: Uint8Array;
  info: ReturnType<typeof inspectBackup>;
}

const state = {
  files: [] as FileState[],
  base: null as FileState | null,
  busy: false,
  resultUrl: null as string | null,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let lastQuip = -1;
function nextQuip(): string {
  let index: number;
  do {
    index = Math.floor(Math.random() * GYM_TALK.length);
  } while (index === lastQuip && GYM_TALK.length > 1);
  lastQuip = index;
  return GYM_TALK[index];
}

function bestBase(): FileState | null {
  const valid = state.files.filter((file) => file.info.ok);
  return valid.reduce(
    (best, file) => ( !best || file.info.sets > best.info.sets ? file : best ),
    null as FileState | null,
  );
}

function renderFiles(): void {
  const valid = state.files.filter((file) => file.info.ok);
  dom.filesPanel.hidden = state.files.length === 0;
  dom.fileCount.textContent = `${state.files.length} file${state.files.length === 1 ? '' : 's'}`;
  dom.merge.disabled = valid.length < 2 || state.busy;
  dom.fileList.replaceChildren(...state.files.map(fileRow));
}

function fileRow(file: FileState): HTMLLIElement {
  const item = document.createElement('li');
  item.className = `file${file.info.ok ? '' : ' invalid'}`;

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'base';
  radio.checked = file === state.base;
  radio.disabled = !file.info.ok || state.busy;
  radio.title = 'use as base backup';
  radio.addEventListener('change', () => {
    state.base = file;
    renderFiles();
  });

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = file.name;

  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = file.info.ok
    ? `${file.info.sets} sets · ${file.info.exercises} exercises · ${file.info.firstDate ?? '—'} → ${file.info.lastDate ?? '—'}`
    : `not readable — ${file.info.error}`;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '✕';
  remove.title = 'remove file';
  remove.disabled = state.busy;
  remove.addEventListener('click', () => {
    state.files = state.files.filter((candidate) => candidate !== file);
    if (state.base === file) state.base = bestBase();
    renderFiles();
  });

  item.append(radio, name, meta, remove);
  return item;
}

async function addFiles(fileList: FileList | null): Promise<void> {
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

/* ------------------------------------------------------------------ progress */

let quipTimer: ReturnType<typeof setInterval> | null = null;

function setProgress(fraction: number): void {
  const pct = Math.max(0, Math.min(1, fraction));
  dom.progressBar.style.width = `${(pct * 100).toFixed(1)}%`;
  dom.progressPct.textContent = `${Math.round(pct * 100)}%`;
  dom.progressPanel.querySelector('.progress-track')!.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
}

function startProgress(): void {
  clearInterval(quipTimer);
  dom.progressPanel.hidden = false;
  dom.progressPanel.classList.remove('done');
  dom.progressLabel.textContent = 'Combobulating your sets…';
  setProgress(0);
  dom.progressQuip.textContent = nextQuip();
  quipTimer = setInterval(() => { dom.progressQuip.textContent = nextQuip(); }, 1500);
}

function finishProgress(): void {
  clearInterval(quipTimer);
  quipTimer = null;
  setProgress(1);
  dom.progressPanel.classList.add('done');
  dom.progressLabel.textContent = 'All reps counted';
  dom.progressQuip.textContent = 'Session complete — merged and re-racked. 🏋️';
}

function stopProgress(): void {
  clearInterval(quipTimer);
  quipTimer = null;
  dom.progressPanel.hidden = true;
}

/* -------------------------------------------------------------------- merge */

async function runMerge(): Promise<void> {
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
    const baseIndex = valid.indexOf(state.base!);
    const result = await mergeBackups(
      valid.map(({ name, bytes: data }) => ({ name, bytes: data })),
      {
        baseIndex: baseIndex >= 0 ? baseIndex : undefined,
        onProgress: (event: ProgressEvent) => {
          if (event.phase === 'merged') {
            completed += 1;
            setProgress(completed / steps);
            dom.progressQuip.textContent = nextQuip();
          } else if (event.phase === 'done') {
            setProgress(1);
          }
        },
      },
    );

    // Keep the bar visible long enough to be seen even for tiny backups.
    await sleep(Math.max(0, MIN_PROGRESS_MS - (performance.now() - startedAt)));
    finishProgress();
    await sleep(650);
    showResult(result.bytes, result.report as MergeReport, valid);
  } catch (error) {
    stopProgress();
    showError(error);
  } finally {
    state.busy = false;
    renderFiles();
  }
}

function reportTable(rows: { table: string; added: number; duplicates: number; skipped: number }[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'report-table';
  const head = document.createElement('tr');
  for (const label of ['Table', 'Added', 'Duplicates', 'Skipped']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  table.append(head);
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const value of [row.table, row.added, row.duplicates, row.skipped]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.append(td);
    }
    table.append(tr);
  }
  return table;
}

function showResult(bytes: Uint8Array, report: MergeReport, files: FileState[]): void {
  const base = files[report.base] ?? files[0];
  dom.resultSummary.textContent = `${report.totals.sets} sets · ${report.totals.exercises} exercises`;

  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  dom.download.onclick = () => {
    const link = document.createElement('a');
    link.href = state.resultUrl;
    link.download = 'FitNotes_Backup_merged.fitnotes';
    document.body.append(link);
    link.click();
    link.remove();
  };

  const parts: Node[] = [];
  const line = document.createElement('p');
  line.className = 'result-line';
  line.textContent = `Base: ${base.name} · integrity check: ${report.integrity} · `
    + `${files.length} files merged · originals untouched`;
  parts.push(line);

  if (report.tables.length) parts.push(reportTable(report.tables));

  if (report.warnings.length) {
    const heading = document.createElement('h3');
    heading.textContent = 'Notes';
    const list = document.createElement('ul');
    list.className = 'warnings';
    for (const warning of report.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.append(item);
    }
    parts.push(heading, list);
  }

  dom.report.replaceChildren(...parts);
  dom.resultPanel.hidden = false;
  dom.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showError(error: unknown): void {
  dom.errorMessage.textContent = error?.message ?? String(error);
  dom.errorPanel.hidden = false;
  dom.errorPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* --------------------------------------------------------------- wiring up */

dom.merge.addEventListener('click', runMerge);
dom.pick.addEventListener('click', (event) => {
  event.stopPropagation();
  dom.fileInput.click();
});
dom.drop.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  dom.fileInput.click();
});
dom.drop.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    dom.fileInput.click();
  }
});
dom.fileInput.addEventListener('change', () => {
  addFiles(dom.fileInput.files);
  dom.fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  dom.drop.addEventListener(type, (event) => {
    event.preventDefault();
    dom.drop.classList.add('drag');
  });
}
for (const type of ['dragleave', 'dragend']) {
  dom.drop.addEventListener(type, () => dom.drop.classList.remove('drag'));
}
dom.drop.addEventListener('drop', (event) => {
  event.preventDefault();
  dom.drop.classList.remove('drag');
  addFiles(event.dataTransfer?.files);
});
