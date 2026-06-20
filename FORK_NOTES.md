# Fork Notes — career-ops, personalized

> **Draft for review.** This is the writeup for my personal fork of career-ops.
> Nothing here is published anywhere yet. Read it, edit it, then decide what (if
> anything) to share.

## Credit

This is a fork of **[career-ops](https://github.com/santifer/career-ops)** by
**[Santiago Fernández de Valderrama](https://santifer.io)** (santifer), used
under the **MIT License**. The original `LICENSE` and copyright notice are kept
intact, as MIT requires. The upstream system — the pipeline, scoring blocks A–G,
CV generation, the zero-token scanner, the provider plugin layer, the dashboard,
the data contract — is all his. The companion portfolio is also open source:
[cv-santiago](https://github.com/santifer/cv-santiago).

If you want the original, unmodified system, go upstream. This fork only adds a
few things on top for my own search and is not affiliated with or endorsed by
the upstream author.

## What this fork adds

career-ops is built to be made yours — the README says so directly. I took it up
on that. Everything below builds *on top of* the upstream architecture using its
own extension points (the provider plugin contract, `modes/_profile.md` for
personalization, `templates/states.yml` for canonical states), so upstream
updates still apply cleanly.

### 1. Region + sponsorship-aware scoring

Personalization for an India-based candidate who is open to remote-international
work and EU relocation but needs visa sponsorship for the US/CA/UK/EU. Added a
per-destination `sponsorship_difficulty` map to `config/profile.yml` (how
realistic sponsorship actually is at my level — e.g. EU Blue Card moderate, US
H-1B very hard) and a deterministic "Region & Sponsorship Scoring" rule in
`modes/_profile.md`: every offer is classified into a region tier (remote-intl /
sponsor-relocation / India / hard-filter), the difficulty penalty is folded into
the North Star dimension, and a role needing work authorization with no
sponsorship is a forced SKIP. Truthfulness is non-negotiable — work-auth
requirements are never fudged. (User-layer only; nothing system-layer changed.)

### 2. Three new scan providers

Added to the upstream zero-token scanner (`scan.mjs`), each following the
`{id, detect, fetch}` provider contract and copying the SSRF hardening from
`providers/greenhouse.mjs` (hostname allowlist + `redirect:'error'`):

- **`arbeitnow`** — EU/DE board feed with strong remote + visa-sponsor coverage.
- **`github`** — reads a repo's open Issues as job postings (issue-per-opening
  boards); `detect()` auto-derives the API from a `github.com/owner/repo` URL.
- **`hackernews`** — the monthly "Who is hiring?" thread via the Algolia API;
  auto-finds the latest thread and parses each top-level comment.

### 3. Discord approval gate

The hard rule of this fork: **nothing is submitted or sent without a logged
human approval.** `discord-gate.mjs` is that gate — zero-infra (a bot token + a
channel id + plain REST; reactions, not buttons, so no daemon and no public
endpoint, matching the `scan.mjs` ethos). It posts an evaluation summary to
Discord, seeds ✅ Approve · ✏️ Edit · ❌ Reject · ⏭️ Skip, and on a later `poll`
reads the reaction and writes the decision back — validated against
`templates/states.yml`, with an append-only audit log at `data/approvals.md`.
Conflicting reactions resolve conservatively (any non-approve beats a stray ✅).

### 4. Funding-signal outreach (suggest-only)

`funding.mjs` surfaces companies that just raised or are actively hiring, from
public sources (SEC EDGAR Form D, TechCrunch venture RSS, Y Combinator's hiring
list), deduped and screened against my blocklist. `modes/outreach.md` turns a
lead into a short, truthful, personalized message — and routes it through the
approval gate before anything is sent. It never contacts anyone on its own, and
LinkedIn stays read-only/manual.

## Principles I kept

- **Quality over quantity, and respect for recruiters' time** — straight from
  upstream's Ethical Use section.
- **Truthfulness is a hard filter**, especially around work authorization.
- **The data contract** — personalization lives in user-layer files
  (`config/profile.yml`, `modes/_profile.md`), never in system-layer files, so
  upstream updates don't clobber it.
- **Zero new runtime infrastructure** — the new pieces are plain Node + REST,
  with secrets in a gitignored `.env`.

## Tests

Every addition ships with unit tests in `test-all.mjs` (providers, the gate,
the funding sources and orchestrator), all network calls mocked. Run
`node test-all.mjs --quick`.
