#!/usr/bin/env node
/**
 * interview-watch.mjs — Detect interview / recruiter replies in Gmail and draft
 * a gated reply for each. READ-ONLY on your mailbox; never sends anything.
 *
 * For every recent inbound message that matches a tracked application, it writes
 * a gate-compatible draft to drafts/ (`# Interview: Company — Role`) containing a
 * first-draft reply you finalize. Post one to the approval gate when ready:
 *   node discord-gate.mjs post drafts/interview-<slug>.md
 * (the gate enforces the kill-switch; nothing leaves without your approval).
 *
 * Config (.env, gitignored — see .env.example):
 *   IMAP_USER       your Gmail address
 *   IMAP_PASSWORD   a Gmail App Password (not your login password)
 *   IMAP_HOST       optional, default imap.gmail.com
 *   IMAP_PORT       optional, default 993
 *
 * Usage:
 *   node interview-watch.mjs            # scan last 7 days, write drafts
 *   node interview-watch.mjs --days=14
 *   node interview-watch.mjs --include-rejections
 *   node interview-watch.mjs --dry-run  # detect + report, write nothing
 *   (add --json for machine-readable output)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  classifyEmail, matchApplication, companiesFromTracker, draftReply,
} from './interview-core.mjs';
import { loadAssets, getAssetPath } from './assets.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPLICATIONS_PATH = join(ROOT, 'data/applications.md');
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || join(ROOT, 'config/profile.yml');
const STATE_PATH = join(ROOT, 'data/interview-watch.json');
const DRAFTS_DIR = join(ROOT, 'drafts');

function parseArgs(argv) {
  const f = { json: false, dryRun: false, days: 7, includeRejections: false };
  for (const a of argv) {
    if (a === '--json') f.json = true;
    else if (a === '--dry-run') f.dryRun = true;
    else if (a === '--include-rejections') f.includeRejections = true;
    else if (a.startsWith('--days=')) { const n = parseInt(a.slice(7), 10); if (Number.isFinite(n) && n > 0) f.days = n; }
  }
  return f;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unknown';
}

function readState() {
  if (!existsSync(STATE_PATH)) return { seen: [] };
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); } catch { return { seen: [] }; }
}
function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Candidate context for the draft — name + timezone from assets/profile. */
function draftContext(company) {
  const assets = loadAssets();
  let name = getAssetPath(assets, 'bios.candidate_name') || '';
  let tz = getAssetPath(assets, 'availability.timezone') || '';
  if ((!name || !tz) && existsSync(PROFILE_PATH)) {
    try {
      const txt = readFileSync(PROFILE_PATH, 'utf-8');
      if (!name) { const m = txt.match(/full_name:\s*["']?([^"'\n]+)/); if (m) name = m[1].trim(); }
      if (!tz) { const m = txt.match(/timezone:\s*["']?([^"'#\n]+)/); if (m) tz = m[1].trim(); }
    } catch { /* ignore */ }
  }
  return { company, candidateName: name, timezone: tz };
}

function buildDraft({ company, role, classification, email, ctx }) {
  const reply = draftReply(classification, ctx);
  return `# Interview: ${company}${role ? ` — ${role}` : ''}\n\n` +
    `**URL:** ${email.url || '(from email — no link)'}\n` +
    `**Type:** ${classification.type}\n` +
    `**From:** ${email.from}\n` +
    `**Subject:** ${email.subject}\n` +
    `**Signals:** ${classification.signals.join(', ') || '—'}\n\n` +
    `## Drafted reply (review + finalize the bracketed slots, then approve via the gate)\n\n` +
    `${reply}\n\n` +
    `---\n_Detected by interview-watch.mjs. Nothing is sent until you post this to the gate and approve._\n`;
}

/** Process a list of parsed emails into drafts. Pure given the inputs — testable. */
export function processEmails(emails, { companies, includeRejections = false, seen = [] } = {}) {
  const seenSet = new Set(seen);
  const drafts = [];
  const skipped = [];
  for (const email of emails) {
    const id = email.id || `${email.from}|${email.subject}`;
    if (seenSet.has(id)) { skipped.push({ id, reason: 'already-seen' }); continue; }
    const classification = classifyEmail(email);
    const wanted = classification.type === 'interview' || classification.type === 'recruiter' ||
      (includeRejections && classification.type === 'rejection');
    if (!wanted) { skipped.push({ id, reason: classification.type }); continue; }
    const company = matchApplication(email, companies);
    if (!company) { skipped.push({ id, reason: 'no-application-match' }); continue; }
    drafts.push({ id, company, type: classification.type, email, classification });
  }
  return { drafts, skipped };
}

async function fetchRecentEmails({ days }) {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;
  if (!user || !pass) throw new Error('IMAP_USER / IMAP_PASSWORD not set (use a Gmail App Password in .env)');

  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT) || 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const out = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      for await (const msg of client.fetch({ since }, { source: true, envelope: true })) {
        const parsed = await simpleParser(msg.source);
        out.push({
          id: parsed.messageId || String(msg.uid),
          from: parsed.from?.text || '',
          subject: parsed.subject || '',
          body: parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '',
          url: '',
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  try { (await import('dotenv')).config({ path: join(ROOT, '.env'), quiet: true }); } catch { /* optional */ }

  const companies = existsSync(APPLICATIONS_PATH)
    ? companiesFromTracker(readFileSync(APPLICATIONS_PATH, 'utf-8'))
    : [];
  if (companies.length === 0) {
    const msg = { error: 'no tracked companies in data/applications.md — nothing to match against' };
    console.log(flags.json ? JSON.stringify(msg) : `❌ ${msg.error}`);
    process.exit(1);
  }

  let emails;
  try {
    emails = await fetchRecentEmails({ days: flags.days });
  } catch (err) {
    const msg = { error: err.message };
    console.log(flags.json ? JSON.stringify(msg) : `❌ ${err.message}`);
    process.exit(1);
  }

  const state = readState();
  const { drafts, skipped } = processEmails(emails, {
    companies, includeRejections: flags.includeRejections, seen: state.seen,
  });

  const written = [];
  if (!flags.dryRun) mkdirSync(DRAFTS_DIR, { recursive: true });
  for (const d of drafts) {
    const ctx = draftContext(d.company);
    const path = join('drafts', `interview-${slugify(d.company)}-${slugify(d.email.subject)}.md`);
    if (!flags.dryRun) {
      writeFileSync(join(ROOT, path), buildDraft({ company: d.company, role: '', classification: d.classification, email: d.email, ctx }));
      state.seen.push(d.id);
    }
    written.push({ company: d.company, type: d.type, subject: d.email.subject, draft: path });
  }
  if (!flags.dryRun) writeState(state);

  if (flags.json) {
    console.log(JSON.stringify({ scanned: emails.length, matched: written.length, drafts: written, skipped: skipped.length }));
    return;
  }
  console.log(`📬 Scanned ${emails.length} message(s) from the last ${flags.days} day(s).`);
  if (written.length === 0) { console.log('No new interview/recruiter replies matched a tracked application.'); return; }
  console.log(`✉️  ${written.length} draft(s)${flags.dryRun ? ' (dry run — not written)' : ''}:`);
  for (const w of written) {
    console.log(`  • ${w.company} [${w.type}] — "${w.subject.slice(0, 60)}"`);
    if (!flags.dryRun) console.log(`      ${w.draft}  → post with: node discord-gate.mjs post ${w.draft}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
