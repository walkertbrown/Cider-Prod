# Plan: the Buffer Commit entry, rebuilt (28 Oct – 13 Nov)

The boss, 28 Oct, on Tap as built: no one comes from their bios, "it's too
simple", and "which post you saw" is a workaround they don't trust to be
precise. Then: "We have a couple weeks. We can really build something", and
of the three directions offered (link to shorts, long video to clips, a
content planner): "We can incorporate all of those things".

## What it is
One app on tap.bananafest-destiny.com, signed in with the Buffer OAuth
client that already works. It makes the content and puts it into Buffer:

1. **Link to Shorts.** Paste any page (product, app, article, store
   listing). The app reads it, writes several short scripts (hook, one
   point, the link), and renders vertical 1080×1920 videos in the user's own
   browser from the page's images, with captions and an optional voiceover.
   You preview them and draft them into Buffer for each network.
   **How many** is the user's choice (1 to 10). The app suggests a number
   from how much the page has (separate facts, features, numbers, images)
   and says why ("this page has 4 distinct points and 6 images: 4
   videos"). Asking for more than the page supports gets angles, not
   repeats, and a warning when they'd overlap. (The boss, 28 Oct: "set how
   many videos you want made from the link... It depends on how much
   information is at the link".)
2. **Store mode.** Paste a store (Shopify's products.json to start) and
   every product becomes its own short. That's the judge's Pokémon-card
   case.
3. **Long video to clips.** Upload a long video. The browser pulls out the
   audio; a speech-to-text model gives timed words; a language model picks
   the best 20–45 second moments. The browser cuts them, crops them to
   vertical and burns in captions.
4. **Planner.** It reads the site and the channels and lays out a month:
   which video or post goes where and when. It fills Buffer's queue as
   drafts, or as Ideas for the ones still to make.
5. **Keep this / Post it again**, from Tap, carried over: a template and a
   tag per winner, and drafts again on other networks.
6. **An MCP server for building in public** (the boss, 28 Oct: "a Claude
   mcp that creates videos based on what you're building"). It's a remote
   MCP at tap.bananafest-destiny.com/mcp, added in one line
   (`claude mcp add --transport http tap <url> --header "Authorization:
   Bearer <tap key>"`). The key comes from the user's Tap page. Claude
   already sees the repo, so it passes what shipped (title, what changed,
   the numbers, screenshots or a live URL) to a tool like
   `make_build_video`. Tap writes the script and returns a review link. The
   video renders in the browser on that page, and one press drafts it to
   Buffer. A person always approves, so nothing posts from an agent alone.
   Other tools: `list_channels`, `draft_post` (text), `queue_status`. Our own
   bots use it every day of the window, so the Build-in-Public entry is
   built in public with itself, and the demo shows Claude Code making the
   video of the work it just did.

Tap's bio page and counted links stay live, as an extra and not the pitch.

## What's already proven (28 Oct, on the boss's account)
- createPost with saveToDraft and a video URL works on Instagram (reel),
  TikTok and YouTube, with a tag. YouTube needs a categoryId. A video can't
  have a thumbnailUrl; Buffer picks the frame itself.
- Templates, tags and ideas can be created and deleted.
- Buffer fetches media from our URL: public, direct, HTTPS, and live until
  the post publishes. So rendered videos are uploaded to Tap and served
  from there (KV holds up to 25 MB a value, enough for a short; R2 if not).
- No metrics (insights:read refused), so nothing depends on them.

## Build order (each step ships alone; the riskiest last)
1. **28–31 Oct: one link, one video, end to end.** Read a page in the
   Worker (title, description, og:image and page images, main text). One
   script from a language model, as JSON with scenes and caption lines.
   Render it in the browser with canvas, WebCodecs and an MP4 muxer:
   images with slow pans, word-by-word captions, an end card with the link.
   Preview it, upload it, and draft it to one channel. Chrome first; check
   Safari.
2. **1–3 Nov: many videos, every network.** Five scripts per link, each
   with a different hook. Captions and titles fit each network (Reels,
   TikTok, Shorts, plus text versions for X, Bluesky, Threads and LinkedIn
   if connected). One press drafts them all, tagged per video. Then
   voiceover (text-to-speech, mixed into the MP4).
3. **4–5 Nov: the MCP server.** Tap keys on /me, the /mcp endpoint
   (Streamable HTTP), the review link, and the drafts. From then on our bots
   use it for their own build-in-public posts.
4. **6–7 Nov: store mode and planner.** products.json → a short for each
   product, in a batch. A month laid out, filled into the queue as drafts
   or Ideas. Keep this / Post it again join the same screens.
5. **8–10 Nov: long video to clips.** The hardest part. If it slips, the
   entry is complete without it.
6. **11–13 Nov: polish, the write-up, the demo video, and submit.** The
   demo uses our own apps (Comic Cover, Puzzle Press, Sizecurve) as the
   links, so it doesn't depend on anyone's traffic.

## Costs and limits
- Every render happens in the visitor's browser, so there's no video
  server.
- Language model, speech-to-text and voiceover calls use the studio's keys,
  so strangers' use costs the boss money. A per-account daily cap, and a
  total monthly cap the boss sets. Ask.
- Buffer: the app shares 250 requests a day. A batch of drafts is one call
  per draft, so cap batches and cache reads.
- Hosted videos are deleted 30 days after the draft is made, or when the
  account disconnects. The privacy page says so.

## What could break
- In-browser encoding: WebCodecs H.264 works in Chrome, Edge and recent
  Safari, but Firefox is patchy. Fall back to a WebM preview with "use
  Chrome to export".
- Pages that block fetching, or have no images: fall back to the page's
  text on designed cards.
- Buffer refusing a video (length, size, aspect): read its error, show it,
  and fix the render settings to fit each network's limits.
- The OAuth client and consent screen are named "Tap". The name may change
  (the boss's call, in Buffer's app settings).

## Step 1 details (28–31 Oct)
- Scripts: OpenAI gpt-5.4-mini returning JSON; voiceover later with
  gpt-4o-mini-tts. Only signed-in Buffer users can call it. Caps until the
  boss sets a budget: 20 script runs a day per account, 200 a day overall.
- Page images go through Tap (/api/img), because a canvas with images from
  another site can't be encoded.
- Render: canvas 1080×1920 at 30 fps, WebCodecs H.264, and the mp4-muxer
  library from jsDelivr. Each scene is an image with a slow pan, the caption
  in big type a few words at a time, then an end card with the link.
- Upload: PUT to Tap, kept in KV (25 MB a value) and served at
  /v/<id>.mp4. Kept 30 days.
- Draft: one createPost per channel the user ticks, using the network
  fields already proven.

## Step 2 details (started 28 Oct)
Already in place: several videos per link (1–10), several links, and music.
- **Voiceover.** Each scene line is read by gpt-4o-mini-tts, one call per
  line, so the voice lines up with its scene. A scene stretches to fit its
  line. Voice choice per video. The music dips under the voice. Caps: 150
  lines a day per account and 1,500 overall, separate from script runs.
- **All at once.** "Render all", then one channel choice and "Draft all".
  Each video is drafted with its own caption and title.
- Later in step 2: captions per network, and a tag per video so Keep this
  can find the winners.

## Step 3 details: the MCP server (started 28 Oct, ahead of the 4–5 Nov slot)
- **Keys.** "Make a Claude key" on /me shows the key once, with the
  one-line `claude mcp add` command. Only a hash is stored (`key:<hash>` →
  account). Making a new key replaces the old one. Disconnect deletes it.
- **Endpoint.** /mcp, Streamable HTTP, stateless JSON-RPC over POST
  (initialize, tools/list, tools/call, ping), with Bearer auth.
- **Tools.**
  - `make_build_video` takes {title, what_changed, details, url?,
    image_urls?, images? (base64 screenshots, up to 4), count?}. It writes
    the scripts in a build-in-public voice and stores a job for 7 days.
    It returns a review link (/make/?job=<id>) where the owner renders and
    drafts. Nothing is drafted without the owner.
  - `list_channels`.
  - `draft_post` makes text drafts on the networks that take text only.
    Posts are drafts, never sent.
  - `queue_status` gives drafts and scheduled posts per channel.
- **Proof.** Add it to this repo's Claude Code and make the video of this
  step with it.

## Step 4 details: store mode (started 28 Oct)
- **Finding the store.** Reading a link also asks the site's origin for
  Shopify's public `/products.json` (or `/collections/<handle>/products.json`
  for a collection link). If it answers with products, the page shows
  "A Shopify store with N products", each with its picture and price.
  Checked from here: some stores answer, and big ones rate-limit (429). That
  needs checking from Cloudflare too. eBay and Whatnot have no public
  product feed like this, so for now a listing's page is pasted as a link.
- **One video per product.** Tick up to 10 products (5 are ticked by
  default). "Write one per product" writes one script for each product
  from its own title, price, description and pictures. The video ends on
  that product's own page. Each product counts as one script run against
  the daily cap.
- **Under the hood.** Each video carries its own page (images, link,
  title), so the products' videos can sit in one batch with Render all and
  Draft all. Images are cached by URL, not by index.
- **Fixes in the same pass.**
  - A review link from Claude Code with no link crashed the end card.
    Now it shows the title.
  - "Write the scripts" again on a review link keeps the build-in-public
    voice.

## Step 4b details: the planner (started 28 Oct)
- **Lay out a month.** After a link (or store) is read, choose posts per
  week (2–7, default 3), weeks (1–4) and a start day. Tap sends the page,
  the products if it's a store, and the connected networks to the script
  model, which returns dated items: the date, networks, video or text,
  the angle and the hook. Videos go to Instagram, TikTok and YouTube. Text
  goes to X, Bluesky, Threads, LinkedIn, Facebook and Mastodon, if
  connected. It counts as one script run.
- **Then, per item:** "Write this video" writes that one script (with the
  item's angle) into the batch below, for Render all and Draft all.
- **Into Buffer:** "Save as Buffer Ideas" makes one Idea per ticked item,
  with its title, hook, notes, date and networks. Ideas are what Buffer
  calls a plan. It happens only when the owner presses the button.
- **Limits.** At most 28 items. Buffer's API has `createIdea` and no
  `deleteIdea`, so ideas can only be deleted in Buffer. The live test makes
  exactly one idea, titled "Test idea from Tap, delete me", and the boss is
  told to delete it.

## Step 5 details: long video to clips (started 28 Oct)
- **Everything heavy stays in the browser.** The long video is opened from
  the device and never uploaded whole. mp4box.js (jsDelivr) reads the MP4
  or MOV index, and WebCodecs decodes only the parts that are needed. MP4
  and MOV only for now, which covers phones and screen recorders.
- **Words with times.** The browser decodes the soundtrack, turns it into
  16 kHz mono WAV in pieces of up to 10 minutes, and sends each piece to
  Tap. Tap passes it to OpenAI's whisper-1 for timed words and sentences.
  Cap: 60 minutes of audio a day per account, 600 overall. Videos up to
  60 minutes.
- **Picking the moments.** The timed sentences go to the script model. It
  returns the N best stand-alone moments (20–60 s each, no overlap), each
  with a title, caption and hashtags. That counts as one script run. N is
  the user's choice (1–10); a number is suggested from the length.
- **Cutting.** For each moment, the browser decodes from the keyframe
  before the start, crops to 9:16 vertical, and burns in captions a few
  words at a time from the timed words. Two layouts: "Fill" crops the
  middle, and "Fit" shows the whole frame on a blurred copy of itself with
  the title above. Phone rotation is honoured. Audio is cut to the same
  times with short fades. Output is H.264 (VP9 fallback) at 30 fps or less.
- **Then** each clip is a card like the others: edit the title, caption
  and hashtags; Render, Render all, Draft, Draft all.
- **Testing.** Playwright's Chromium can't decode H.264, so the tests use
  Chrome for Testing (it decodes H.264 and AAC). The test file is a
  94-second H.264/AAC talk made here, with a clock on screen to check the
  cut points.

## The name: Dailies (28 Oct)
The boss, asked whether it's still "Tap": "It is your product". Tap was the
bio-link counter; the app now makes videos. Of the names I offered, Cutroom
is already an AI vertical-video editor (cutroomai.com) and Spool is an iOS
music-video editor, so it's **Dailies**: the short cuts you make every day.
- Every visible "Tap" becomes "Dailies": page titles, /make, /me, privacy,
  the MCP server name and messages, and new Buffer tags ("Dailies: …").
  The landing page is rewritten for what it is now: make shorts, plan
  them, draft them into Buffer, and the Claude Code MCP.
- It stays on tap.bananafest-destiny.com for now. A new subdomain needs a
  new callback URL in the Buffer app (the boss's), so it waits for them.
  Keys keep their `tap_` prefix and the MCP URL is unchanged, so nothing
  already set up breaks.
- The Buffer app's own name (on Buffer's sign-in screen) is the boss's to
  change in Buffer's app settings.
