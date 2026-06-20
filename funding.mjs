#!/usr/bin/env node
/**
 * funding.mjs — Recently-funded / actively-hiring company leads for outreach.
 *
 * Pulls "this company just got money / is scaling" signals from public sources
 * (SEC EDGAR Form D, TechCrunch venture RSS, Y Combinator hiring list), dedups
 * across them, screens out blocklisted employers (config/profile.yml) and flags
 * companies already in the tracker, and prints leads.
 *
 * SUGGEST-ONLY. This script never contacts anyone. Outreach drafted from these
 * leads MUST go through the approval gate (discord-gate.mjs) before you send it
 * — see modes/outreach.md and the hard rule in modes/_shared.md.
 *
 * Usage:
 *   node funding.mjs [--source=sec-formd,techcrunch,yc] [--limit=N]
 *                    [--batch="Summer 2026"] [--min-team=N] [--include-funds]
 *                    [--include-tracked] [--json]
 *
 * Config (.env, optional): SEC_USER_AGENT="Your Name your@email" (SEC asks for
 * a descriptive UA with contact info on EDGAR requests).
 */

import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeHttpCtx } from './providers/_http.mjs';
import {
  normalizeCompany,
  isBlocked,
  loadBlocklistConfig,
  loadRecentCompanies,
} from './_blocklist.mjs';

// Re-exported so existing importers/tests keep resolving funding.normalizeCompany.
export { normalizeCompany };

const ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = join(ROOT, 'funding-sources');
const PROFILE_PATH = join(ROOT, 'config/profile.yml');

/** Load source modules from funding-sources/ (skipping _-prefixed helpers). */
export async function loadSources(dir = SOURCES_DIR) {
  const sources = new Map();
  if (!existsSync(dir)) return sources;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.mjs') || file.startsWith('_')) continue;
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const s = mod.default;
    if (s && s.id && typeof s.fetch === 'function') sources.set(s.id, s);
  }
  return sources;
}

/** Normalized blocklist terms from config/profile.yml (substring-matched). */
export function loadBlocklist(profilePath = PROFILE_PATH) {
  return loadBlocklistConfig(profilePath).terms;
}

/** Resolve the tracker path (data/ layout preferred, root fallback). */
function applicationsPath(root = ROOT) {
  return existsSync(join(root, 'data/applications.md'))
    ? join(root, 'data/applications.md')
    : join(root, 'applications.md');
}

/**
 * Companies in the tracker within the re-apply cooldown window. Same 8-week
 * (default) semantics the scanner uses — after the window a company can be
 * surfaced for outreach again. See _blocklist.mjs.
 */
export function loadTrackedCompanies(root = ROOT, cooldownWeeks) {
  return loadRecentCompanies(applicationsPath(root), cooldownWeeks);
}

/**
 * Merge per-source leads into one deduped list keyed by normalized company,
 * annotated with blocklist/tracker status. Pure: takes raw leads, returns the
 * merged list. Exported for tests.
 *
 * @param {Array<object>} rawLeads
 * @param {{blocklist?: Iterable<string>, tracked?: Set<string>, includeBlocked?: boolean, includeTracked?: boolean}} opts
 *   blocklist: normalized terms (substring-matched via isBlocked); tracked: normalized keys (exact).
 */
export function mergeLeads(rawLeads, { blocklist = new Set(), tracked = new Set(), includeBlocked = false, includeTracked = false } = {}) {
  const byKey = new Map();
  for (const lead of rawLeads) {
    const key = normalizeCompany(lead.company);
    if (!key) continue;
    const blocked = isBlocked(lead.company, blocklist);
    const inTracker = tracked.has(key);
    if (blocked && !includeBlocked) continue;
    if (inTracker && !includeTracked) continue;

    if (!byKey.has(key)) {
      byKey.set(key, {
        company: lead.company,
        sources: [],
        signals: [],
        url: lead.url || '',
        ...(lead.ycProfile ? { ycProfile: lead.ycProfile } : {}),
        ...(lead.location ? { location: lead.location } : {}),
        ...(lead.teamSize != null ? { teamSize: lead.teamSize } : {}),
        ...(lead.industry ? { industry: lead.industry } : {}),
        ...(lead.amount ? { amount: lead.amount } : {}),
        date: lead.date || '',
        blocked,
        inTracker,
      });
    }
    const merged = byKey.get(key);
    if (!merged.sources.includes(lead.source)) merged.sources.push(lead.source);
    if (lead.signal && !merged.signals.includes(lead.signal)) merged.signals.push(lead.signal);
    if (!merged.url && lead.url) merged.url = lead.url;
    if (!merged.location && lead.location) merged.location = lead.location;
  }
  return [...byKey.values()];
}

function parseArgs(argv) {
  const flags = { json: false, sources: null, limit: 0, batch: '', minTeam: 0, includeFunds: false, includeTracked: false, includeBlocked: false };
  for (const a of argv) {
    if (a === '--json') flags.json = true;
    else if (a === '--include-funds') flags.includeFunds = true;
    else if (a === '--include-tracked') flags.includeTracked = true;
    else if (a === '--include-blocked') flags.includeBlocked = true;
    else if (a.startsWith('--source=')) flags.sources = a.slice(9).split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--limit=')) flags.limit = parseInt(a.slice(8), 10) || 0;
    else if (a.startsWith('--batch=')) flags.batch = a.slice(8);
    else if (a.startsWith('--min-team=')) flags.minTeam = parseInt(a.slice(11), 10) || 0;
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const sources = await loadSources();
  if (sources.size === 0) {
    const msg = { error: 'no funding sources loaded from funding-sources/' };
    console.log(flags.json ? JSON.stringify(msg) : `❌ ${msg.error}`);
    process.exit(1);
  }

  const selected = flags.sources
    ? flags.sources.filter(id => sources.has(id))
    : [...sources.keys()];

  const ctx = makeHttpCtx();
  const rawLeads = [];
  const errors = [];
  const sourceOpts = { batch: flags.batch, minTeam: flags.minTeam, includeFunds: flags.includeFunds };

  for (const id of selected) {
    try {
      let leads = await sources.get(id).fetch(ctx, sourceOpts);
      if (flags.limit > 0) leads = leads.slice(0, flags.limit);
      rawLeads.push(...leads);
    } catch (err) {
      errors.push({ source: id, error: err.message });
    }
  }

  const blocklistCfg = loadBlocklistConfig(PROFILE_PATH);
  const merged = mergeLeads(rawLeads, {
    blocklist: blocklistCfg.terms,
    tracked: loadTrackedCompanies(ROOT, blocklistCfg.cooldownWeeks),
    includeBlocked: flags.includeBlocked,
    includeTracked: flags.includeTracked,
  });

  if (flags.json) {
    console.log(JSON.stringify({ leads: merged, errors, sources: selected }, null, 2));
  } else {
    console.log(`💸 ${merged.length} funding/hiring leads from ${selected.join(', ')}\n`);
    for (const l of merged.slice(0, 50)) {
      const tags = [l.inTracker ? 'in-tracker' : '', l.teamSize != null ? `~${l.teamSize}` : '', l.location || ''].filter(Boolean).join(' · ');
      console.log(`• ${l.company}  [${l.sources.join(',')}]${tags ? `  (${tags})` : ''}`);
      if (l.signals[0]) console.log(`    ${l.signals[0].slice(0, 100)}`);
      if (l.url) console.log(`    ${l.url}`);
    }
    for (const e of errors) console.log(`⚠️  ${e.source}: ${e.error}`);
    console.log('\nSuggest-only. Draft outreach via modes/outreach.md and approve it through discord-gate.mjs before sending.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(`❌ ${err.message}`); process.exit(1); });
}
