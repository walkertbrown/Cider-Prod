# Handoff, 2026-10-31 (vibecider4)

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
- **Buffer Commit**, build window 28 Oct – 13 Nov 11:59 PM PT (submit app +
  write-up + demo video; judging from 16 Nov). The app is Dailies at
  tap.bananafest-destiny.com, signed in with the boss's Buffer OAuth client
  (credentials in `.git-credentials`). Plan: `plan/2026-10-28-buffer-commit-studio.md`;
  log: `actual/2026-10-28.md`.
- The UI plan (7 steps) is done and live by 28 Oct: one stylesheet
  (`public/ui.css`), one header, the home hero (a real short in
  `public/home/`, served with byte ranges by the worker for Safari).
- Live on /make/ by 28 Oct: link to shorts (several links, 1–10 videos,
  voiceover, music, Render all / Draft all), store mode (Shopify),
  the planner (Buffer Ideas), the Claude Code MCP at /mcp, and long video to
  clips (`public/make/clips.js`). Testing video needs Chrome for Testing,
  because Playwright's Chromium can't decode H.264.
- **"Put yourself in it"**, live 29 Oct on /make/ under a read page: the
  creator's own talking video, cut out of its background in the browser
  (MediaPipe selfie segmenter, `public/make/you.js`), over a real full-page
  screenshot of the site (Cloudflare Browser Rendering, worker routes
  `/api/shot` and `/api/scroll` in `src/make.js`) that scrolls to what they
  say. Plan `plan/2026-10-29-dailies-you-in-it.md`, log
  `actual/2026-10-29.md`. Worker secrets `BR_TOKEN` and `CF_ACCOUNT_ID`
  are set (values in `.git-credentials` as CLOUDFLARE_API_TOKEN and
  CLOUDFLARE_ACCOUNT_ID; a local dev run needs them in a `.dev.vars`,
  deleted after). Test clips are in the scratchpad only. Headless renders
  are slow because of software H.264 encode (387 ms a frame), not the
  cutout. Not tried with a real phone video yet: the boss's try.
- Same card, later 29 Oct (plan `plan/2026-10-29-dailies-record.md`, log in
  the second half of `actual/2026-10-29.md`): "Or record it here" (camera,
  teleprompter, "Write one for me" via `POST /api/say`), the screenshot
  taken ahead of time, music under the voice, and a gold pointer that
  presses the element a spoken instruction names (`tap` on the planner's
  keyframes). Then the boss rejected how the render looked ("I mean, thats
  not good enough. Look at those screenshots") and the frame was recomposed:
  page in a phone-shaped window on a blurred backdrop, person bottom-right
  under half the frame, captions in a dark box beside them, pointer in the
  window. Test scripts are in the scratchpad (`pwt/look.mjs` for stills in
  about a minute, `pwt/rec5.mjs` for a full render with forced taps and
  music, `pwt/rec4.mjs` for the recorder with a fake camera); the test
  footage is public-domain NASA video, never committed. **Always put frames
  of a render in front of the boss before shipping a look change.**
- Same day, after the boss's "Go for it." to the three edits a socials app
  is wanted for (plan `plan/2026-10-29-dailies-edit.md`, log in the third
  part of `actual/2026-10-29.md`): captions that pop the word being said,
  pauses cut out of a take or a clip (loudness kept while listening), and
  Fill on a wide clip following the person (the selfie segmenter, now
  shared in `public/make/seg.js`). A wide video defaults to Fill when a
  person is found in it. Live 29 Oct, after the boss was sent frame strips
  and a sample clip. Test script for clips: `pwt/tc2.mjs` in the
  scratchpad. `node --check` passes `.js` files here without parsing them;
  check a copy named `.mjs`.
- 29 Oct: the redeploy for vibe-cider was done (no 10013; mail sent) and
  tap has `/sitemap.xml` and `/robots.txt` for docent.
- Asked the boss: the monthly AI budget. Caps stay until they answer.
- The boss's open walkthroughs are in `forboss/` (gitignored, RULES
  "Walkthroughs for the boss"): delete the Buffer test idea ("Test idea from
  Tap, delete me"), rename the Buffer app to Dailies, the optional
  insights:read question, and the Bobo Reddit post. When the boss says
  "Done: …", tick it there.

## Next
1. Check mail/in. Check Stripe for a first $9 Comic Cover sale (none on
   28 Oct; the one paid checkout on the account is another bot's, 29 Sep).
   now.md lists all four products; keep each status true.
2. (done 28 Oct: Keep this / Post it again / Make more like this on /me) (the known gap). Then
   step 6 (11–13 Nov): polish, write-up, demo video, submit.
3. Phase 19 (a stranger pays $9 for a pet drawing): Reddit is the only
   channel that sends people. Bobo question to the boss still open.
4. (done 31 Oct: ShelfCall and Hullbound checked and added to the proof
   list on / and /vibe-coded-apps/; log `actual/2026-10-31.md`.)

## Boss words since 24 Oct not elsewhere
- All logged in FACTS.md (the visit counter). The boss also asked "When is
  the buffer commit?" (28 Oct), answered.
