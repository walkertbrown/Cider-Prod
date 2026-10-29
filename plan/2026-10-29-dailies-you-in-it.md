# Plan, 29 Oct: "Put yourself in it" (the creator over the page)

The boss (28 Oct): a scrolling site alone is not impressive; what is, is
"creating videos from a link combined with videos of creator talking about
it. Overlay the creator on top of the scrolling".

## What the audience sees
A person, cut out of their own room (no green screen), over their real
website as it scrolls to what they are saying. Captions from their words.
Their voice is the voiceover; music, if any, sits under it.

## The pieces, in build order
1. **Cutout, proved first.** MediaPipe Image Segmenter (selfie model) in the
   browser, run on each frame as the encoder asks for it, mask at the
   model's size, blurred edge, drawn with destination-in. Must run in
   Chrome for Testing headless (CPU) for tests, and with the GPU delegate in
   real Chrome. If it is too slow: mask every 2nd frame and reuse.
   Fallbacks with no model: "Bubble" (circle crop) and "Split" (you on top,
   page below).
2. **The creator's video in.** Upload (MP4/MOV, same decode path as clips)
   or record in the page (getUserMedia + MediaRecorder) with the script as
   a teleprompter. Sound to /api/hear as clips do: words with times.
3. **The page behind.** Today's page-image scenes, plus the real site:
   one full-page phone screenshot and the positions of headings and
   buttons from Cloudflare Browser Rendering (/screenshot, /scrape), fetched
   by the worker right after "Read the pages", cached in KV by URL for a
   day. Free tier: 10 min/day, one call per 10 s, so it runs in the
   background and the video falls back to picture scenes if it is not
   there.
4. **Scroll keyed to speech.** GPT gets the transcript (with times) and the
   page outline (headings, buttons, their y). It returns keyframes
   {t, y, tap?}. The renderer eases between them, draws a cursor, and taps
   the button when it is named.
5. **Layouts.** Cutout (bottom third, soft shadow), Bubble (circle, bottom
   left), Split (top 45% you, page below). Captions above the person.
6. **Render and draft** through the existing side panel; poster saved;
   Buffer draft as now. Clip titles/captions from the transcript.

## Limits and costs
- Whisper per minute as for clips (same daily caps). No new paid service.
- Browser Rendering on the free tier; if a day runs out, picture scenes.
- iPhone HEVC uploads: same advice as clips; recording in the page avoids
  it.

## Done when
A link plus a phone video of someone talking renders, in Chrome, to a
vertical MP4 with the person cut out over the scrolling page, captions in
time, and drafts to Buffer. Tested headless with a stock video of a person
talking (not committed), then by the boss with a real one.
