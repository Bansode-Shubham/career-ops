// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// GitHub provider — treats a repository's open Issues as job postings, via the
// public REST API (https://api.github.com/repos/{owner}/{repo}/issues). Many
// companies and communities run issue-based job boards (one issue per opening,
// often label-filtered). Zero auth needed (unauthenticated rate limit: 60
// req/hr — plenty for periodic scans).
//
// Wire in EITHER way:
//   - Explicit: `provider: github` + `repo: "owner/name"` (and optional
//     `labels: "job,hiring"`, `state: open`, `maxPages`, `pageSize`).
//   - Auto-detect: a `careers_url` of the form https://github.com/owner/repo
//     (optionally /issues) — detect() derives the issues API URL.

const API_HOST = 'api.github.com';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 1;

const ALLOWED_API_HOSTS = new Set([API_HOST]);
const ALLOWED_HTML_HOSTS = new Set(['github.com', 'www.github.com']);

/** @param {string} url */
function assertGithubApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`github: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`github: URL must use HTTPS: ${url}`);
  if (!ALLOWED_API_HOSTS.has(parsed.hostname))
    throw new Error(`github: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_API_HOSTS].join(', ')}`);
  return url;
}

/**
 * Extract `owner/repo` from an entry — explicit `repo:` wins, else parse a
 * github.com careers_url. Returns null when neither yields a valid slug.
 * @param {import('./_types.js').PortalEntry & {repo?: string}} entry
 * @returns {{owner: string, repo: string}|null}
 */
export function resolveRepo(entry) {
  const slug = (entry.repo || '').trim();
  if (slug) {
    const m = slug.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (m) return { owner: m[1], repo: m[2] };
    return null;
  }
  const careers = entry.careers_url || '';
  let parsed;
  try {
    parsed = new URL(careers);
  } catch {
    return null;
  }
  if (!ALLOWED_HTML_HOSTS.has(parsed.hostname)) return null;
  const m = parsed.pathname.match(/^\/([\w.-]+)\/([\w.-]+)/);
  if (!m) return null;
  // Strip a trailing ".git" some clone URLs carry.
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

function buildIssuesUrl({ owner, repo, labels, state, pageSize, page }) {
  const url = new URL(`https://${API_HOST}/repos/${owner}/${repo}/issues`);
  url.searchParams.set('state', state || 'open');
  if (labels) url.searchParams.set('labels', labels);
  url.searchParams.set('per_page', String(pageSize || DEFAULT_PAGE_SIZE));
  url.searchParams.set('page', String(page || 1));
  return url.href;
}

// NaN-safe Date.parse (created_at is an ISO 8601 string).
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Parse a single GitHub issue into the canonical Job shape. Pull requests
 * (which the issues endpoint also returns) carry a `pull_request` key and are
 * rejected. Exported for unit tests.
 *
 * @param {any} issue — raw issue object
 * @param {string} fallbackCompany — company name fallback from the portal entry
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}|null}
 */
export function parseGithubIssue(issue, fallbackCompany) {
  if (!issue || typeof issue !== 'object') return null;
  if (issue.pull_request) return null; // not a job — it's a PR

  const title = typeof issue.title === 'string' ? issue.title.trim() : '';
  if (!title) return null;

  const rawUrl = typeof issue.html_url === 'string' ? issue.html_url.trim() : '';
  let url = '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' && ALLOWED_HTML_HOSTS.has(parsed.hostname)) url = parsed.href;
  } catch {
    return null;
  }
  if (!url) return null;

  const company = fallbackCompany ? fallbackCompany.trim() : 'GitHub';

  // Labels frequently encode location/remote — surface any that look like one.
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map(l => (typeof l === 'string' ? l : (l && l.name))).filter(Boolean)
    : [];
  const locLabel = labels.find(l => /remote|onsite|hybrid|location/i.test(l));
  const location = locLabel ? String(locLabel).trim() : '';

  const description = typeof issue.body === 'string' ? issue.body.trim() : '';
  const postedAt = toEpochMs(issue.created_at);

  return {
    title,
    url,
    company,
    location,
    ...(description ? { description } : {}),
    ...(postedAt != null ? { postedAt } : {}),
  };
}

/** @type {Provider} */
export default {
  id: 'github',

  detect(entry) {
    const repo = resolveRepo(entry);
    if (!repo) return null;
    return { url: buildIssuesUrl({ owner: repo.owner, repo: repo.repo }) };
  },

  async fetch(entry, ctx) {
    const repo = resolveRepo(entry);
    if (!repo) throw new Error(`github: cannot derive owner/repo for ${entry.name} — set repo: "owner/name" or a github.com careers_url`);

    const labels = entry.labels || '';
    const state = entry.state || 'open';
    const pageSize = Number(entry.pageSize) || DEFAULT_PAGE_SIZE;
    const maxPages = Number(entry.maxPages) || DEFAULT_MAX_PAGES;
    const fallbackCompany = entry.name || repo.owner;

    const allJobs = [];

    for (let page = 1; page <= maxPages; page++) {
      const apiUrl = buildIssuesUrl({ owner: repo.owner, repo: repo.repo, labels, state, pageSize, page });
      assertGithubApiUrl(apiUrl);

      let json;
      try {
        // redirect:'error' prevents SSRF via server-side redirects; the Accept
        // header pins the v3 JSON media type.
        json = /** @type {any} */ (await ctx.fetchJson(apiUrl, {
          redirect: 'error',
          headers: { accept: 'application/vnd.github+json' },
        }));
      } catch (err) {
        if (page === 1) throw err;
        console.error(`github: page ${page} fetch failed — ${err.message}`);
        break;
      }

      const issues = Array.isArray(json) ? json : [];
      if (issues.length === 0) break;

      for (const issue of issues) {
        const job = parseGithubIssue(issue, fallbackCompany);
        if (job) allJobs.push(job);
      }

      if (issues.length < pageSize) break; // last page
    }

    return allJobs;
  },
};
