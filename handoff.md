# fontCIA — Handoff (current status)

This file always describes "where we are right now." Overwrite it every session, it's not a history log.

## Current objective

Step 8: usage/tier gating — actually enforce the Free (20 scans/month) vs Pro (unlimited) limits. It's the top unchecked item in backlog.md's must-have list and the last unbuilt roadmap step; everything else in "must-have before launch" is manual QA, security, or store-submission work rather than new product logic.

## Current status

fontCIA is roughly 85% done as of 2026-07-30. All 8 roadmap steps except Step 8 are merged, plus the full AI image-matching phase that was built as an unplanned detour ahead of schedule. What's left is one product feature (tier gating), two skipped manual test passes, a security pass, and Chrome Web Store submission assets.

## What was just finished

- Step 7 (account dashboard): login/signup, saved fonts, scan history, and settings views with a working theme toggle, tab orchestration guarded against stale renders and same-tab reclicks.
- Manifest and build now point at the account dashboard; the old standalone login page was removed.

## What's next (in order)

1. Step 8: usage/tier gating (Free/Pro scan limits actually enforced).
2. Manual Chrome test pass for sub-project 4b (login flow, Save persistence) — deliberately skipped when that sub-project merged.
3. Manual Chrome test pass for the AI image-match client-wiring sub-project (ranked results, per-candidate save) — same, deliberately skipped.
4. Comprehensive security pass (rate limiting audit, input validation consistency, crash/error reporting).
5. Chrome Web Store submission package (listing, screenshots, privacy policy, terms of service, permissions justification).

## Open problems / blockers

- AI match rejection thresholds (`DISTANCE_CEILING`, `MARGIN_THRESHOLD`) are derived only from a 100-font closed-set measurement — no genuinely out-of-catalog fonts have been tested against them.
- The AI catalog is still a curated 100 fonts and the DOM known-fonts table only 10; the full ~1,500-font Google Fonts catalog expansion is deferred nice-to-have work, not blocking launch but shapes how useful either path feels.

## Risks

- Shipping Step 8 without re-testing the two skipped manual QA passes risks compounding regressions that manual-only code paths (real Chrome APIs, not unit-testable) wouldn't otherwise catch.
- No security pass has happened yet outside the auth-endpoint rate limiting built in sub-project 4a; input validation consistency and crash/error reporting are unaudited going into a public launch.

---
Update this at the END of every coding session, in 2 minutes, before you close the laptop. This is the single most important habit for keeping AI costs down and avoiding "wait, what was I doing again" confusion.
