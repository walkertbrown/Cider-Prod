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
3. **4–5 Nov: store mode.** products.json → a short per product, in a
   batch.
4. **6–7 Nov: planner.** A month laid out, filled into the queue as drafts
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
