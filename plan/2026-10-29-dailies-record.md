# Plan, 29 Oct: record it here, and the rest of "Put yourself in it"

The boss (29 Oct): "go for the next steps". These are the parts of
`plan/2026-10-29-dailies-you-in-it.md` that were left, in the order that
pays off most for someone watching the demo.

## 1. Record in the page, with a teleprompter
- A "Record it here" button beside "Choose your video". It opens the
  camera (front, portrait if the device has it) in a mirrored preview with
  a 3-2-1 count, a timer, and Stop at 90 s.
- The words to say sit over the top of the preview in large type and roll
  up at a reading pace once recording starts (about 150 words a minute,
  with a pace slider). They come from a box the person can type in, or
  from "Write one for me": a new `POST /api/say {page, seconds}` that asks
  the same model for one spoken paragraph in the first person, from the
  page's facts only. It counts as a script run.
- The take is kept with MediaRecorder as MP4 (Chrome and Safari give
  `video/mp4`; Chrome's is fragmented, so `open()` learns to read a
  fragmented file by taking it whole, up to 300 MB, and Opus sound). Then
  it goes through the same path as a dropped file: review it, "Use this
  take" or "Again", then "Make the video".
- Where the browser can only record WebM (Firefox), the button says so and
  points at dropping a file instead.

## 2. The page's picture, ahead of time
- The screenshot is asked for as soon as a video is picked or recording
  starts, not when "Make the video" is pressed, so by then it is usually
  there. Not on every page read: a screenshot costs browser time on
  Cloudflare's free tier, and most reads never use this card.

## 3. Music under the voice
- The same "Add music" control as the other cards, mixed under the voice
  at the low level used under a voiceover.

## 4. A finger that taps
- The scroll plan can name one element per stop to tap. The renderer
  draws a soft round pointer that glides to it during the stop and
  presses, so when the person says "press Slab it" the page is seen being
  pressed. Scroll stays the same when nothing is named.

## Tests
- Headless Chrome for Testing with its fake camera and microphone
  (`--use-fake-device-for-media-stream`): record 15 s, open the take,
  make the video. The fake camera draws a moving pattern with no person,
  so the cutout falls back to the bubble; the recording path is what is
  tested. The cutout itself was tested on 29 Oct with real footage.
- The boss, with a real phone: the thing that matters.

## Done when
Someone with no video on hand can press Record, read the words off the
screen, stop, and get the finished video, all on tap.bananafest-destiny.com,
in Chrome or Safari.
