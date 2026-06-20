/**
 * interview-core.mjs — Pure logic for inbound recruiter/interview email.
 *
 * No network, no IMAP — just classification, matching to a tracked application,
 * and a draft reply. interview-watch.mjs supplies the live email; this file is
 * the testable brain. Nothing here sends anything.
 */
import { normalizeCompany } from './_blocklist.mjs';

// Order matters: a rejection that also says "interview" is still a rejection.
const REJECTION_SIGNALS = [
  /\bunfortunately\b/i,
  /\bnot (be )?moving forward\b/i,
  /\bnot (be )?proceeding\b/i,
  /\bdecided (not )?to (move|proceed|go)\b/i,
  /\bdecided to (move|proceed|go) (forward|ahead) with (other|another)\b/i,
  /\bother candidates?\b/i,
  /\bwe regret\b/i,
  /\bwish you (the best|luck)\b/i,
  /\bwon'?t be moving\b/i,
];
const INTERVIEW_SIGNALS = [
  /\binterview\b/i,
  /\bphone screen\b/i,
  /\btechnical screen(ing)?\b/i,
  /\bnext steps?\b/i,
  /\bschedule (a |an )?(call|chat|meeting|time|conversation)\b/i,
  /\bset up (a |an )?(call|time|chat)\b/i,
  /\bavailabilit(y|ies)\b/i,
  /\bwhen are you (free|available)\b/i,
  /\bmove forward\b/i,
  /\bhiring manager\b/i,
  /\btake[- ]?home\b/i,
  /\bcoding (challenge|exercise|test)\b/i,
  /\b(zoom|google meet|meet\.google|teams)\b/i,
];
const RECRUITER_SIGNALS = [
  /\brecruit(er|ing)\b/i,
  /\btalent (acquisition|partner|team)\b/i,
  /\bsourcer\b/i,
  /\bcame across your (profile|resume|cv)\b/i,
  /\bexciting opportunit(y|ies)\b/i,
];

function matchedSources(text, patterns) {
  return patterns.filter(re => re.test(text)).map(re => re.source);
}

/**
 * @param {{subject?: string, body?: string, from?: string}} email
 * @returns {{type: 'rejection'|'interview'|'recruiter'|'other', signals: string[]}}
 */
export function classifyEmail({ subject = '', body = '' } = {}) {
  const text = `${subject}\n${body}`;
  const rej = matchedSources(text, REJECTION_SIGNALS);
  if (rej.length) return { type: 'rejection', signals: rej };
  const intv = matchedSources(text, INTERVIEW_SIGNALS);
  if (intv.length) return { type: 'interview', signals: intv };
  const rec = matchedSources(text, RECRUITER_SIGNALS);
  if (rec.length) return { type: 'recruiter', signals: rec };
  return { type: 'other', signals: [] };
}

/** Pull the bare address out of a From header ("Jane <jane@x.com>" → jane@x.com). */
export function extractEmailAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  const addr = (m ? m[1] : from || '').trim().toLowerCase();
  return addr.includes('@') ? addr : '';
}

/** Registrable-ish label of an address domain (jane@careers.mistral.ai → mistral). */
export function domainRoot(addr) {
  const at = String(addr || '').indexOf('@');
  if (at < 0) return '';
  let host = addr.slice(at + 1);
  host = host.replace(/^(mail|email|careers|jobs|talent|hr|no-?reply|notifications?|reply)\./, '');
  const parts = host.split('.').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || '');
}

/** Company names from the applications.md tracker table (col 3). Pure. */
export function companiesFromTracker(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    const company = cells[3];
    if (company && company.toLowerCase() !== 'company' && normalizeCompany(company)) out.push(company);
  }
  return [...new Set(out)];
}

/**
 * Match an email to one of the tracked companies via sender domain, then the
 * company name appearing in subject/body. Returns the raw company name or null.
 */
export function matchApplication({ from = '', subject = '', body = '' } = {}, companies = []) {
  const list = [...companies].map(c => ({ raw: c, key: normalizeCompany(c) })).filter(c => c.key);
  if (list.length === 0) return null;

  const dom = normalizeCompany(domainRoot(extractEmailAddress(from)));
  if (dom && dom.length >= 3) {
    for (const c of list) {
      if (c.key === dom || c.key.includes(dom) || dom.includes(c.key)) return c.raw;
    }
  }
  const text = normalizeCompany(`${subject} ${body}`);
  // Longest keys first so "n26" doesn't shadow a longer, more specific match.
  for (const c of [...list].sort((a, b) => b.key.length - a.key.length)) {
    if (c.key.length >= 3 && text.includes(c.key)) return c.raw;
  }
  return null;
}

/**
 * A safe, honest first-draft reply. Never auto-sent — the user finalizes the
 * bracketed slots and approves via the gate.
 */
export function draftReply(classification, ctx = {}) {
  const { company = '', candidateName = '', timezone = '' } = ctx;
  const at = company ? ` at ${company}` : '';
  const sign = candidateName ? `\n\nBest,\n${candidateName}` : '';

  if (classification.type === 'rejection') {
    return `Thank you for letting me know, and for taking the time to consider my application${at}. ` +
      `I appreciate it. If a role that fits opens up in the future, I'd be glad to reconnect.${sign}`;
  }
  const tz = timezone ? ` I'm in ${timezone} and` : ' I';
  return `Thanks for reaching out — I'd be glad to talk${at}.${tz} can be flexible to find a good overlap. ` +
    `A few windows that work for me: [add 2–3 slots]. ` +
    `Happy to use whatever scheduling link or tool you prefer.${sign}`;
}
