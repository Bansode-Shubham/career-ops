#!/usr/bin/env node
/**
 * discord-gate.mjs — Human approval gate over Discord (reactions + REST poll).
 *
 * The hard rule of this fork: nothing is ever submitted or sent without a
 * LOGGED human approval. This script is that gate. It posts an evaluation
 * summary to a Discord channel, seeds four reaction choices, and — on a later
 * poll — reads the human's reaction and writes the decision back to the tracker
 * (status validated against templates/states.yml) plus an append-only audit log
 * (data/approvals.md). No buttons, no daemon, no public endpoint: a bot token +
 * a channel id + plain REST, the same zero-infra model as scan.mjs.
 *
 * Usage:
 *   node discord-gate.mjs post  <reportNum|reportPath>   # post + seed reactions
 *   node discord-gate.mjs poll  [reportNum | --all]      # resolve decision(s)
 *   node discord-gate.mjs status                         # list gate entries
 *   (add --json to any command for machine-readable output)
 *
 * Config (.env, gitignored — see .env.example):
 *   DISCORD_BOT_TOKEN   bot token with permission to post in the channel
 *   DISCORD_CHANNEL_ID  channel to post approval requests into
 *   DISCORD_API_BASE    optional override (default https://discord.com/api/v10)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, rmSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATES_PATH = join(ROOT, 'templates/states.yml');
const STATE_FILE = join(ROOT, 'data/discord-gate.json');
const AUDIT_LOG = join(ROOT, 'data/approvals.md');
const REPORTS_DIR = join(ROOT, 'reports');

const DEFAULT_API_BASE = 'https://discord.com/api/v10';
const ALLOWED_DISCORD_HOSTS = new Set(['discord.com']);

// ── Decision model ──────────────────────────────────────────────────
//
// Reactions map to canonical states.yml transitions. Variation selectors
// (U+FE0F) are stripped before matching so ✏️/✏ and ⏭️/⏭ compare equal.
// Priority is deliberately conservative: any non-approve reaction wins over
// Approve, so a stray ✅ next to a ❌ never auto-sends.

export const SEED_EMOJI = ['✅', '✏️', '❌', '⏭️'];

export const EMOJI_DECISIONS = {
  '✅': { action: 'approve', status: 'Applied', label: 'Approve' },
  '✏': { action: 'edit', status: 'Evaluated', label: 'Edit' },
  '❌': { action: 'reject', status: 'Discarded', label: 'Reject' },
  '⏭': { action: 'skip', status: 'SKIP', label: 'Skip' },
};

// Conservative: index 0 wins. Approve is last so it never overrides a stop.
const DECISION_PRIORITY = ['❌', '⏭', '✏', '✅'];

/** Strip emoji variation selectors so seeded and stored names compare equal. */
export function normalizeEmoji(name) {
  return typeof name === 'string' ? name.replace(/️/g, '') : '';
}

/**
 * Resolve a single decision from a Discord message's `reactions` array. A
 * reaction counts as a human decision when its count exceeds the bot's own
 * seed (count - (me ? 1 : 0) > 0). Returns the highest-priority decision, or
 * null when only seed reactions are present.
 *
 * @param {Array<{emoji?:{name?:string}, count?:number, me?:boolean}>} reactions
 * @returns {{emoji:string, action:string, status:string, label:string}|null}
 */
export function resolveDecisionFromReactions(reactions) {
  if (!Array.isArray(reactions)) return null;
  const human = new Set();
  for (const r of reactions) {
    const key = normalizeEmoji(r?.emoji?.name);
    if (!EMOJI_DECISIONS[key]) continue;
    const count = Number(r.count) || 0;
    const humanCount = count - (r.me ? 1 : 0);
    if (humanCount > 0) human.add(key);
  }
  for (const key of DECISION_PRIORITY) {
    if (human.has(key)) return { emoji: key, ...EMOJI_DECISIONS[key] };
  }
  return null;
}

// ── Canonical states (templates/states.yml is the source of truth) ──
// Mirrors tracker.mjs loadStates so the gate validates against the same set.

export function loadStates(statesPath = STATES_PATH) {
  if (!existsSync(statesPath)) {
    throw new Error(`states.yml not found at ${statesPath} — run from the career-ops root`);
  }
  const doc = yaml.load(readFileSync(statesPath, 'utf-8'));
  const byKey = new Map();
  const labels = [];
  for (const s of doc?.states || []) {
    if (!s?.label) continue;
    labels.push(s.label);
    byKey.set(s.label.toLowerCase(), s.label);
    if (s.id) byKey.set(String(s.id).toLowerCase(), s.label);
    for (const alias of s.aliases || []) byKey.set(String(alias).toLowerCase(), s.label);
  }
  return { byKey, labels };
}

export function validateStatus(status, states) {
  const cleaned = String(status || '').replace(/\*\*/g, '').trim().toLowerCase();
  return states.byKey.get(cleaned) || null;
}

// ── Report parsing ──────────────────────────────────────────────────

/**
 * Parse the header block of a report .md into structured fields. Reports use a
 * stable `**Key:** value` header (see modes/oferta.md). Exported for tests.
 *
 * @param {string} markdown
 * @returns {{company:string, role:string, date:string, url:string, archetype:string, score:string, legitimacy:string, pdf:string}}
 */
export function parseReportHeader(markdown) {
  const text = String(markdown || '');
  const titleMatch = text.match(/^#\s*(?:Evaluation|Evaluación):\s*(.+?)\s*$/m);
  let company = '', role = '';
  if (titleMatch) {
    // Split on the first em/en dash or hyphen-with-spaces separating company — role.
    const parts = titleMatch[1].split(/\s[—–-]\s/);
    company = (parts.shift() || '').trim();
    role = parts.join(' — ').trim();
  }
  const field = (name) => {
    const m = text.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+?)\\s*$`, 'm'));
    return m ? m[1].trim() : '';
  };
  return {
    company,
    role,
    date: field('Date') || field('Fecha'),
    url: field('URL'),
    archetype: field('Archetype') || field('Arquetipo'),
    score: field('Score'),
    legitimacy: field('Legitimacy'),
    pdf: field('PDF'),
  };
}

/** Parse a numeric score out of a "4.3/5" style cell. */
export function parseScoreNumber(score) {
  const m = String(score || '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
}

/** Resolve a report num or path to an absolute report file path. */
export function resolveReportPath(arg, reportsDir = REPORTS_DIR) {
  if (!arg) return null;
  if (arg.endsWith('.md') || arg.includes('/')) {
    const p = resolve(arg);
    return existsSync(p) ? p : null;
  }
  const num = String(arg).padStart(3, '0');
  if (!existsSync(reportsDir)) return null;
  const match = readdirSync(reportsDir).find(f => f.startsWith(`${num}-`) && f.endsWith('.md'));
  return match ? join(reportsDir, match) : null;
}

/** Extract the report number from a report file path. */
export function reportNumFromPath(p) {
  const m = basename(p).match(/^(\d+)-/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Embed building ──────────────────────────────────────────────────

function scoreColor(score) {
  const n = parseScoreNumber(score);
  if (Number.isNaN(n)) return 0x95a5a6;       // grey — unknown
  if (n >= 4.5) return 0x2ecc71;              // green — strong
  if (n >= 4.0) return 0x3498db;              // blue — good
  if (n >= 3.5) return 0xf1c40f;              // yellow — borderline
  return 0xe74c3c;                            // red — below bar
}

/**
 * Build a Discord embed from a parsed report header. Exported for tests.
 * @param {ReturnType<typeof parseReportHeader>} header
 * @param {number} reportNum
 */
export function buildApprovalEmbed(header, reportNum) {
  const fields = [
    header.score && { name: 'Score', value: header.score, inline: true },
    header.legitimacy && { name: 'Legitimacy', value: header.legitimacy, inline: true },
    header.archetype && { name: 'Archetype', value: header.archetype, inline: false },
    header.pdf && { name: 'PDF', value: header.pdf, inline: false },
    { name: 'Report', value: `#${reportNum}`, inline: true },
  ].filter(Boolean);

  return {
    title: `${header.company || 'Unknown'}${header.role ? ` — ${header.role}` : ''}`.slice(0, 256),
    ...(header.url ? { url: header.url } : {}),
    description: 'Approve to log the application. ✅ Approve · ✏️ Edit · ❌ Reject · ⏭️ Skip',
    color: scoreColor(header.score),
    fields,
    footer: { text: 'career-ops approval gate' },
    timestamp: new Date().toISOString(),
  };
}

// ── Tracker write-back (in-place status update — Pipeline rule 2) ────

const HEADER_ALIASES = {
  '#': 'num', 'num': 'num', 'status': 'status', 'report': 'report',
  'notes': 'notes', 'score': 'score', 'company': 'company', 'role': 'role',
};

function detectCols(lines) {
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim().toLowerCase());
    const map = {};
    cells.forEach((c, i) => { if (HEADER_ALIASES[c] != null) map[HEADER_ALIASES[c]] = i; });
    if (map.report != null && map.status != null) return map;
  }
  return null;
}

/**
 * Update a tracker row's status (and append a note) in place, matched by the
 * report number in the Report column. Pure: takes and returns the tracker text.
 * Throws when the columns or the target row cannot be found. Exported for tests.
 *
 * @param {string} trackerText
 * @param {number} reportNum
 * @param {string} newStatus — canonical label (validate before calling)
 * @param {string} [note]
 * @returns {string}
 */
export function updateTrackerStatus(trackerText, reportNum, newStatus, note = '') {
  const lines = trackerText.split('\n');
  const cols = detectCols(lines);
  if (!cols) throw new Error('tracker: could not detect Status/Report columns');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cells = line.split('|');
    if (cells.length <= cols.report) continue;
    const m = cells[cols.report].match(/\[(\d+)\]/);
    if (!m || parseInt(m[1], 10) !== reportNum) continue;

    cells[cols.status] = ` ${newStatus} `;
    if (cols.notes != null && note) {
      const existing = (cells[cols.notes] || '').trim();
      cells[cols.notes] = ` ${existing ? `${existing}; ${note}` : note} `;
    }
    lines[i] = cells.join('|');
    return lines.join('\n');
  }
  throw new Error(`tracker: no row found with report [${reportNum}]`);
}

function resolveTrackerPath() {
  if (process.env.CAREER_OPS_TRACKER) return process.env.CAREER_OPS_TRACKER;
  const dataPath = join(ROOT, 'data/applications.md');
  return existsSync(dataPath) ? dataPath : join(ROOT, 'applications.md');
}

function writeFileAtomic(path, content) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ── Audit log (append-only — the "logged approval" the hard rule requires) ──

const AUDIT_HEADER = `# Approval Gate Log

Append-only audit trail of every Discord approval-gate event. Never edit past
rows. (See discord-gate.mjs — the hard rule: nothing is sent without a logged
human approval.)

| Timestamp (UTC) | Report | Company | Role | Event | Decision | Status | Message ID |
|-----------------|--------|---------|------|-------|----------|--------|------------|
`;

export function appendAuditRow(logPath, row) {
  if (!existsSync(logPath)) {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, AUDIT_HEADER);
  }
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  const line = `| ${esc(row.timestamp)} | ${esc(row.reportNum)} | ${esc(row.company)} | ${esc(row.role)} | ${esc(row.event)} | ${esc(row.decision)} | ${esc(row.status)} | ${esc(row.messageId)} |\n`;
  writeFileSync(logPath, readFileSync(logPath, 'utf-8') + line);
}

// ── Gate state (machine-readable pending/resolved records) ──────────

function readState() {
  if (!existsSync(STATE_FILE)) return { entries: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { entries: {} };
  }
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ── Discord REST client (injectable fetch for tests) ────────────────

export function assertDiscordUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`discord: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`discord: URL must use HTTPS: ${url}`);
  if (!ALLOWED_DISCORD_HOSTS.has(parsed.hostname))
    throw new Error(`discord: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_DISCORD_HOSTS].join(', ')}`);
  return url;
}

/**
 * Create a minimal Discord REST client. `fetchImpl` is injectable so tests can
 * run without network. Every request is host-checked and uses redirect:'error'
 * to block SSRF via server-side redirects.
 */
export function createClient({ token, channelId, apiBase = DEFAULT_API_BASE, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('discord: DISCORD_BOT_TOKEN is not set');
  if (!channelId) throw new Error('discord: DISCORD_CHANNEL_ID is not set');
  assertDiscordUrl(apiBase);

  async function call(path, { method = 'GET', body } = {}) {
    const url = `${apiBase}${path}`;
    assertDiscordUrl(url);
    const res = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
        'user-agent': 'career-ops-gate (https://github.com/santifer/career-ops, 1.0)',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`discord: HTTP ${res.status} on ${method} ${path}${txt ? ` — ${txt.slice(0, 200)}` : ''}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    postEmbed(embed) {
      return call(`/channels/${channelId}/messages`, { method: 'POST', body: { embeds: [embed] } });
    },
    addReaction(messageId, emoji) {
      const e = encodeURIComponent(emoji);
      return call(`/channels/${channelId}/messages/${messageId}/reactions/${e}/@me`, { method: 'PUT' });
    },
    getMessage(messageId) {
      return call(`/channels/${channelId}/messages/${messageId}`);
    },
  };
}

// ── Commands ────────────────────────────────────────────────────────

async function cmdPost(arg, { json, client, channelId }) {
  const reportPath = resolveReportPath(arg);
  if (!reportPath) throw new Error(`post: report not found for "${arg}" (expected reports/{num}-*.md or a path)`);
  const reportNum = reportNumFromPath(reportPath);
  const header = parseReportHeader(readFileSync(reportPath, 'utf-8'));

  const embed = buildApprovalEmbed(header, reportNum);
  const message = await client.postEmbed(embed);
  for (const emoji of SEED_EMOJI) {
    await client.addReaction(message.id, emoji);
  }

  const state = readState();
  state.entries[String(reportNum)] = {
    reportNum,
    reportPath: reportPath.replace(`${ROOT}/`, ''),
    company: header.company,
    role: header.role,
    score: header.score,
    messageId: message.id,
    channelId,
    status: 'pending',
    postedAt: new Date().toISOString(),
  };
  writeState(state);

  appendAuditRow(AUDIT_LOG, {
    timestamp: new Date().toISOString(),
    reportNum, company: header.company, role: header.role,
    event: 'posted', decision: '—', status: 'pending', messageId: message.id,
  });

  const result = { command: 'post', reportNum, company: header.company, role: header.role, messageId: message.id, status: 'pending' };
  if (json) console.log(JSON.stringify(result));
  else console.log(`📨 Posted approval request for #${reportNum} ${header.company} — ${header.role} (message ${message.id}). React in Discord, then run: node discord-gate.mjs poll ${reportNum}`);
  return result;
}

async function cmdPoll(arg, { json, client, states }) {
  const state = readState();
  const all = arg === '--all' || !arg;
  const targets = Object.values(state.entries).filter(e =>
    e.status === 'pending' && (all || String(e.reportNum) === String(arg)));

  if (targets.length === 0) {
    const out = { command: 'poll', resolved: [], pending: [], message: 'no pending entries matched' };
    if (json) console.log(JSON.stringify(out)); else console.log('Nothing pending to poll.');
    return out;
  }

  const resolved = [];
  const pending = [];
  const trackerPath = resolveTrackerPath();

  for (const entry of targets) {
    const message = await client.getMessage(entry.messageId);
    const decision = resolveDecisionFromReactions(message.reactions || []);
    if (!decision) { pending.push(entry.reportNum); continue; }

    const canonical = validateStatus(decision.status, states);
    if (!canonical) throw new Error(`poll: "${decision.status}" is not a canonical state in states.yml`);

    // Write the decision back to the tracker (in-place status update).
    if (existsSync(trackerPath)) {
      const note = `gate ${decision.action} ${new Date().toISOString().slice(0, 10)}`;
      const updated = updateTrackerStatus(readFileSync(trackerPath, 'utf-8'), entry.reportNum, canonical, note);
      writeFileAtomic(trackerPath, updated);
    }

    entry.status = 'resolved';
    entry.decision = decision.action;
    entry.resolvedStatus = canonical;
    entry.resolvedAt = new Date().toISOString();
    state.entries[String(entry.reportNum)] = entry;

    appendAuditRow(AUDIT_LOG, {
      timestamp: entry.resolvedAt,
      reportNum: entry.reportNum, company: entry.company, role: entry.role,
      event: 'decision', decision: decision.label, status: canonical, messageId: entry.messageId,
    });

    resolved.push({ reportNum: entry.reportNum, decision: decision.action, status: canonical });
  }

  writeState(state);

  const out = { command: 'poll', resolved, pending };
  if (json) console.log(JSON.stringify(out));
  else {
    for (const r of resolved) console.log(`✅ #${r.reportNum} → ${r.decision} (${r.status})`);
    if (pending.length) console.log(`⏳ Still pending: ${pending.join(', ')}`);
    if (!resolved.length && pending.length) console.log('No decisions yet — react in Discord and poll again.');
  }
  return out;
}

function cmdStatus({ json }) {
  const state = readState();
  const entries = Object.values(state.entries);
  if (json) { console.log(JSON.stringify({ command: 'status', entries })); return; }
  if (!entries.length) { console.log('No gate entries yet.'); return; }
  console.log('Report  Status     Decision   Company — Role');
  for (const e of entries.sort((a, b) => a.reportNum - b.reportNum)) {
    console.log(`#${String(e.reportNum).padEnd(5)} ${String(e.status).padEnd(10)} ${String(e.decision || '—').padEnd(10)} ${e.company} — ${e.role}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const args = argv.filter(a => a !== '--json');
  const command = args[0];
  const arg = args[1];

  if (!command || ['help', '-h', '--help'].includes(command)) {
    console.log('Usage: node discord-gate.mjs <post|poll|status> [reportNum] [--json]');
    process.exit(command ? 0 : 1);
  }

  // Lazy dotenv load (dep already in package.json). Pure functions above don't
  // need it; only the live commands do.
  try { (await import('dotenv')).config({ path: join(ROOT, '.env'), quiet: true }); } catch { /* optional */ }

  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const apiBase = process.env.DISCORD_API_BASE || DEFAULT_API_BASE;

  try {
    if (command === 'status') return void cmdStatus({ json });

    const states = loadStates();
    const client = createClient({ token, channelId, apiBase });

    if (command === 'post') await cmdPost(arg, { json, client, channelId });
    else if (command === 'poll') await cmdPoll(arg, { json, client, states });
    else throw new Error(`unknown command "${command}"`);
  } catch (err) {
    if (json) console.log(JSON.stringify({ error: err.message }));
    else console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

// Only run as a CLI, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
