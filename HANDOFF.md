# Handoff, 2026-10-28 (vibecider4)

No keys or secrets here. Everything below is also in git unless noted.

## Done since 24 Oct
- 26 Oct: told the boss what I needed (status list). Asked one question,
  **not yet answered**: will the boss post the Bobo draft
  (`outbox/2026-10-20-reddit-bobo.md`, gitignored) to r/aiArt, or should I
  change it first?
- 27 Oct: the boss's pulse visit counter. The tag
  `<script src="https://pulse.bananafest-destiny.com/p.js" data-site="vibecider.bananafest-destiny.com" defer></script>`
  is in the <head> of every HTML file in `site/` and
  `demo/comiccover/public/`. Both workers deployed; 14 live URLs checked.
  Commit 2effe80. **Any new page I make must carry this tag** (data-site =
  the hostname it is served from). roundrobin. and comiccover. hostnames
  only 301 to vibecider., so they serve no pages.
- 27 Oct: an old background job (music render wait) was stopped for low
  memory. Not needed; not restarted.
- 28 Oct: told the boss the Buffer Commit dates. Wrote market-nana's build
  order into `plan/2026-10-21-buffer-commit-channels.md`.
- 23 Oct (before the cut, for safety): new last sections in MAIL.md and
  RULES.md: questions for the boss can go to market-nana with
  `for_boss: yes`; a relayed answer is `from_boss: yes` + `quote:`, and only
  the quote goes in FACTS.md.

## In the middle of
- **Buffer Commit**, build window 28 Oct – 13 Nov 11:59 PM PT (only work in
  the window is judged; submit app + write-up + demo video; judging from
  16 Nov; winners 7 Dec). Waiting on the boss: create the OAuth app at
  publish.buffer.com/settings/api with redirect
  `https://tap.bananafest-destiny.com/auth/callback`, and put
  BUFFER_CLIENT_ID / BUFFER_CLIENT_SECRET in `.git-credentials`.
- Asked the boss what the 27 Oct Q&A said (metrics, template/tag scope,
  rate limits). No answer yet.

## Next
1. Check mail/in. Check Stripe for a first $9 Comic Cover sale.
2. When the Buffer credentials are in: first call tests `Post.metrics` and
   which scope covers templates and tags; then build in the plan's order,
   tap page first, end to end, before anything else. Plan before, actual
   after, commit and push.
3. Phase 19 (a stranger pays $9 for a pet drawing): Reddit is the only
   channel that sends people. Pinterest blocks the domain; Facebook gave only
   link previews.

## Boss words since 24 Oct not elsewhere
- All logged in FACTS.md (the visit counter). The boss also asked "When is
  the buffer commit?" (28 Oct), answered.
