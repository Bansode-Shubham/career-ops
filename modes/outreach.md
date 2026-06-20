# Mode: outreach — Warm outreach to funded / hiring companies

Turn a funding/hiring signal into a short, truthful, personalized outreach
message — and route it through the approval gate before anything is sent.

**This mode is SUGGEST-ONLY.** It drafts and stages outreach. It never sends.
The human approves via Discord (`discord-gate.mjs`), then sends manually.
**LinkedIn stays read-only/manual** — never automate LinkedIn actions.

## When to use

- "Find companies that just raised and draft outreach"
- "Who's hiring that I should reach out to?"
- The user pastes a company name / funding article and asks for a cold message.

## Step 1 — Get leads

Run the lead finder (zero LLM cost, public sources):

```bash
node funding.mjs --json            # all sources
node funding.mjs --source=yc --min-team=10   # narrow
```

Sources: `sec-formd` (Form D capital raises), `techcrunch` (funding news),
`yc` (YC companies actively hiring). Output is deduped and already screens out
blocklisted employers (`config/profile.yml`) and flags companies already in the
tracker (`inTracker`). Leads are noisy by nature (Form D includes SPVs/funds) —
**triage to a handful of genuine fits** before drafting. Do not draft outreach
for every lead; quality over quantity (see Ethical Use in AGENTS.md).

## Step 2 — Qualify each chosen lead

For each company the user wants to pursue:
1. Confirm it's an operating company that plausibly hires for the user's
   archetypes (`modes/_profile.md`). Drop funds, SPVs, holding entities.
2. Quick research (WebSearch): what they do, the raise/role, a real hook.
3. Check region/sponsorship fit using the rule in `modes/_profile.md`
   (remote-intl / sponsor-relocation / India). If it's a hard filter
   (needs work auth they don't offer), say so and skip — never imply
   authorization the user doesn't hold.

## Step 3 — Draft the message

Write a short outreach message (≤ 120 words). Apply the writing rules:
- `voice-dna.md` Tier 2 (conversational) + `_profile.md` `## Writing Style`.
- Truthful: only real metrics/proof points from `cv.md` + `article-digest.md`.
- One concrete hook tied to their funding/hiring signal, one line on the
  user's most relevant proof point, one clear ask. No corporate-speak.

Save the draft to `output/outreach-{company-slug}-{YYYY-MM-DD}.md` with a header
the gate can read:

```markdown
# Outreach: {Company} — {contact or angle}

**Date:** {YYYY-MM-DD}
**URL:** {company / role / funding link}
**Score:** {fit 1-5, from the _profile region+archetype rules}
**Channel:** {email | LinkedIn (manual) | careers form}

---

{the message body}
```

`output/` is gitignored. Never put the user's phone number in a message.

## Step 4 — Route through the approval gate (MANDATORY)

Nothing goes out without a logged approval:

```bash
node discord-gate.mjs post output/outreach-{company-slug}-{YYYY-MM-DD}.md
# react in Discord (✅ Approve · ✏️ Edit · ❌ Reject · ⏭️ Skip), then:
node discord-gate.mjs poll {slug}
```

The gate posts the draft summary, records the decision in `data/approvals.md`
(append-only audit log), and resolves conservatively (any non-approve beats a
stray ✅). Outreach drafts have no tracker row, so the gate only logs them — the
logged ✅ is the authoritative approval.

Decision handling:
- ✅ **Approve** → tell the user it's cleared to send; they send it manually
  (you never click send; LinkedIn always manual).
- ✏️ **Edit** → revise the draft per their note and re-post to the gate.
- ❌ **Reject** / ⏭️ **Skip** → drop it. Don't resurface the same lead without a
  reason.

If the gate isn't configured (`DISCORD_BOT_TOKEN`/`DISCORD_CHANNEL_ID` absent),
fall back to an explicit in-chat confirmation and STILL stop before sending.

## Step 5 — Record

After an approved send (done by the user), note it in `data/follow-ups.md` so
the follow-up cadence (`followup-cadence.mjs`) can track it. Do not create a
tracker application entry for cold outreach unless it converts to a real
application.
