/**
 * _blocklist.mjs — Shared, deterministic blocklist + re-apply cooldown.
 *
 * Used by scan.mjs (discovery) and funding.mjs (outreach) so a blocklisted
 * employer (e.g. the user's current company) can NEVER reach scan results,
 * evaluations, or outreach drafts. Enforced in code, never left to the LLM.
 *
 * Blocklist matching is SUBSTRING-based on a normalized (lowercase, alphanumeric)
 * company key, so "Emerson" also catches "Emerson Electric Co.",
 * "Emerson Automation Solutions", etc. For subsidiaries/aliases that do NOT
 * contain the parent name (e.g. National Instruments, AspenTech), add the full
 * name to config/profile.yml → blocklist.subsidiaries. Do NOT add short
 * ambiguous tokens ("NI", "GE") — substring matching would false-positive.
 *
 * The re-apply cooldown suppresses any company already in data/applications.md
 * whose tracker date is within `blocklist.cooldown_weeks` (default 8) of now.
 * After the window elapses the company can re-surface.
 *
 * The leading `_` keeps scan.mjs's provider loader from importing this as a
 * provider.
 */
import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';

export const DEFAULT_COOLDOWN_WEEKS = 8;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Lowercase-alphanumeric company key for substring/cooldown matching. */
export function normalizeCompany(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Read blocklist terms + cooldown window from config/profile.yml.
 * @returns {{terms: string[], cooldownWeeks: number}}
 */
export function loadBlocklistConfig(profilePath) {
  const fallback = { terms: [], cooldownWeeks: DEFAULT_COOLDOWN_WEEKS };
  if (!profilePath || !existsSync(profilePath)) return fallback;
  try {
    const doc = yaml.load(readFileSync(profilePath, 'utf-8'));
    const names = (doc?.blocklist?.companies || []).concat(doc?.blocklist?.subsidiaries || []);
    const terms = [...new Set(names.map(normalizeCompany).filter(Boolean))];
    const cw = Number(doc?.blocklist?.cooldown_weeks);
    return { terms, cooldownWeeks: Number.isFinite(cw) && cw > 0 ? cw : DEFAULT_COOLDOWN_WEEKS };
  } catch {
    return fallback;
  }
}

/**
 * True if `companyName` is blocklisted. Substring match on normalized keys.
 * @param {string} companyName
 * @param {Iterable<string>} terms — normalized blocklist terms (array or Set)
 */
export function isBlocked(companyName, terms) {
  const key = normalizeCompany(companyName);
  if (!key) return false;
  for (const t of terms) {
    if (t && key.includes(t)) return true;
  }
  return false;
}

/**
 * Normalized company keys present in applications.md within the cooldown window.
 * Tracker layout: | # | Date | Company | Role | ...  (Date is YYYY-MM-DD).
 * Undated or unparseable-date rows are treated as in-cooldown (safe — never
 * silently re-surface a company we can't date).
 *
 * @param {string} applicationsPath
 * @param {number} cooldownWeeks
 * @param {Date} now
 * @returns {Set<string>}
 */
export function loadRecentCompanies(applicationsPath, cooldownWeeks = DEFAULT_COOLDOWN_WEEKS, now = new Date()) {
  const set = new Set();
  if (!applicationsPath || !existsSync(applicationsPath)) return set;
  const cutoff = now.getTime() - cooldownWeeks * MS_PER_WEEK;
  for (const line of readFileSync(applicationsPath, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    // cells[0]='' (leading pipe), [1]=#, [2]=Date, [3]=Company
    const dateStr = cells[2];
    const company = cells[3];
    const key = normalizeCompany(company);
    if (!key || (company || '').toLowerCase() === 'company') continue;
    const t = Date.parse(dateStr);
    if (Number.isNaN(t) || t >= cutoff) set.add(key);
  }
  return set;
}
