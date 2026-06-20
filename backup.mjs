#!/usr/bin/env node
/**
 * backup.mjs — Snapshot the irreplaceable user state into a tar.gz archive.
 *
 * Backs up data/ and reports/ (the tracker, pipeline, scan history, approvals,
 * gate state, and every evaluation report) plus the gitignored personalization
 * files (cv.md, config/profile.yml, modes/_profile.md, article-digest.md) when
 * present — those live only on disk, so a backup is their only safety net.
 *
 * Zero dependencies: shells out to `tar`. Archives land in backups/ (gitignored)
 * and old ones are pruned to the most recent N (default 14).
 *
 * Usage:
 *   node backup.mjs                 # create a backup, prune to last 14
 *   node backup.mjs --keep=30       # keep the most recent 30
 *   node backup.mjs --out=DIR       # write archives somewhere else
 *   node backup.mjs --list          # list existing backups, newest first
 *   node backup.mjs --dry-run       # show what would happen, write nothing
 *   (add --json to any command for machine-readable output)
 */
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEEP = 14;
const DEFAULT_OUT = 'backups';
const PREFIX = 'career-ops-backup-';

// Candidate paths (relative to ROOT). Only those that exist are archived.
const BACKUP_PATHS = [
  'data',
  'reports',
  'cv.md',
  'config/profile.yml',
  'modes/_profile.md',
  'article-digest.md',
];

export function parseArgs(argv) {
  const flags = { json: false, list: false, dryRun: false, keep: DEFAULT_KEEP, out: DEFAULT_OUT };
  for (const a of argv) {
    if (a === '--json') flags.json = true;
    else if (a === '--list') flags.list = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--keep=')) {
      const n = parseInt(a.slice(7), 10);
      if (Number.isFinite(n) && n >= 0) flags.keep = n;
    } else if (a.startsWith('--out=')) flags.out = a.slice(6) || DEFAULT_OUT;
  }
  return flags;
}

/** Timestamped archive name, e.g. career-ops-backup-2026-06-21-153012.tar.gz */
export function backupName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-` +
             `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${PREFIX}${ts}.tar.gz`;
}

/** Which candidate paths actually exist under root. */
export function backupSources(root = ROOT) {
  return BACKUP_PATHS.filter(p => existsSync(join(root, p)));
}

/** Backup archives in a dir, newest first (by name — names sort chronologically). */
export function listBackups(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter(f => f.startsWith(PREFIX) && f.endsWith('.tar.gz'))
    .sort()
    .reverse();
}

/** Given backup filenames (newest first) and a keep count, which to delete. */
export function planPrune(files, keep) {
  if (!Number.isFinite(keep) || keep < 0) return [];
  return files.slice(keep);
}

function createBackup({ root = ROOT, outDir, dryRun, now = new Date() } = {}) {
  const sources = backupSources(root);
  if (sources.length === 0) {
    return { ok: false, error: 'nothing to back up (no data/, reports/, or user files found)' };
  }
  const name = backupName(now);
  const absOut = join(root, outDir);
  const archivePath = join(absOut, name);

  if (dryRun) {
    return { ok: true, dryRun: true, archive: join(outDir, name), sources };
  }

  mkdirSync(absOut, { recursive: true });
  // -C root keeps archive entries relative (data/..., reports/..., cv.md).
  const res = spawnSync('tar', ['-czf', archivePath, '-C', root, ...sources], { encoding: 'utf-8' });
  if (res.status !== 0) {
    return { ok: false, error: `tar failed (${res.status}): ${(res.stderr || '').trim().slice(0, 300)}` };
  }
  const bytes = existsSync(archivePath) ? statSync(archivePath).size : 0;
  return { ok: true, archive: join(outDir, name), sources, bytes };
}

function prune({ root = ROOT, outDir, keep, dryRun }) {
  const absOut = join(root, outDir);
  const toDelete = planPrune(listBackups(absOut), keep);
  if (!dryRun) for (const f of toDelete) rmSync(join(absOut, f), { force: true });
  return toDelete;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const absOut = join(ROOT, flags.out);

  if (flags.list) {
    const files = listBackups(absOut);
    if (flags.json) { console.log(JSON.stringify({ out: flags.out, backups: files })); return; }
    if (files.length === 0) { console.log(`No backups in ${flags.out}/`); return; }
    console.log(`${files.length} backup(s) in ${flags.out}/ (newest first):`);
    for (const f of files) {
      const size = (statSync(join(absOut, f)).size / 1024).toFixed(0);
      console.log(`  ${f}  (${size} KB)`);
    }
    return;
  }

  const result = createBackup({ outDir: flags.out, dryRun: flags.dryRun });
  if (!result.ok) {
    if (flags.json) console.log(JSON.stringify({ error: result.error }));
    else console.error(`❌ ${result.error}`);
    process.exit(1);
  }
  const pruned = prune({ outDir: flags.out, keep: flags.keep, dryRun: flags.dryRun });

  if (flags.json) {
    console.log(JSON.stringify({ ...result, keep: flags.keep, pruned }));
    return;
  }
  const tag = result.dryRun ? '(dry run) would create' : 'Created';
  const size = result.bytes != null ? `  (${(result.bytes / 1024).toFixed(0)} KB)` : '';
  console.log(`✅ ${tag} ${result.archive}${size}`);
  console.log(`   included: ${result.sources.join(', ')}`);
  if (pruned.length) console.log(`   pruned ${pruned.length} old backup(s) beyond --keep=${flags.keep}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
