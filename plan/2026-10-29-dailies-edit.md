# Plan, 29 Oct: the three edits that make a short look made by a pro

The boss asked what else a socials app would be wanted for. I named six
things Dailies doesn't do and picked the first three; the boss: "Go for it."
All three stay inside what Dailies is (a link, a store or a long video in;
shorts, plans and Buffer drafts out), all run in the browser like the rest,
and none needs a new paid service.

## 1. Captions that pop word by word
- Today a caption chunk (up to 3 or 4 words) appears whole. Now the word
  being said is drawn gold and pops (about 1.2× for a fifth of a second,
  then 1.06×) while the rest of the chunk stays white.
- Clips and "Put yourself in it" have the time of every word from the
  speech-to-text, so the pop lands on the word. Link videos have no word
  times (their text is written, then maybe read aloud), so the chunk's time
  is shared among its words by length.
- One drawing routine in `app.js` serves the centred captions (links,
  clips, split) and the boxed captions beside the person.
- Each card gets a "Captions" choice: Word by word (the default), Line at a
  time (as now), Off where there was a checkbox.

## 2. Cutting the dead air out of a take
- While the sound is read for the words, its loudness is kept too (50 times
  a second, from the same 16 kHz stream). A pause is a stretch quieter than
  the person's speaking level that lasts over half a second and that no
  word sits in. Each pause is cut down to about a fifth of a second, with a
  little room kept either side. Silence before the first word and after the
  last is cut the same way.
- whisper-1 leaves out "um" and "uh", so they show as pauses and go too.
- Picture: each output frame shows the source frame at the mapped time, as
  now, just with the cut stretches skipped. Sound: the kept pieces are laid
  end to end with 15 ms fades so the joins don't click. Captions, the scroll
  stops and the pointer move with the cuts.
- In the clip layouts the picture alternates between two zooms at each cut
  (a punch-in), so a jump cut reads as an edit, not a glitch.
- On by default on clip cards and on "Put yourself in it"; a checkbox turns
  it off, and the card says how many pauses and seconds were taken out.

## 3. Following the face when a wide video goes vertical
- "Fill" on a clip crops to the middle today. Now it follows the person:
  the selfie segmenter the cutout already loads finds them 4 times a second,
  the biggest figure wins when there are two, and the crop glides after them
  with a dead zone so it doesn't wander. At a pause cut it jumps straight
  there, hidden by the cut.
- The segmenter moves into its own small module, shared by clips and
  "Put yourself in it".
- A wide video now defaults to Fill when a person is found in it (three
  frames are checked when the clips are made), and stays on Fit when not,
  for a screen recording, say.

## Tests (local dev server, Chrome for Testing, public-domain NASA footage
## in the scratchpad, never committed)
- Captions: stills mid-word on a link video, a clip and a "you" video.
- Pauses: the talk clip with its sound muted in two stretches; the render
  should be about that much shorter, and the captions still on the words.
- Follow: a wide clip where the speaker sits left of centre, and one where
  the frame pans so they drift across it; frames should keep the face in.
- The recorder and the pointer runs again, to see nothing broke.
- Then frames in front of the boss before it ships (the rule from 29 Oct).

## Not in this
- Following whoever is talking when two people are on screen.
- A brand kit, other languages, hook variants: later, if the boss wants.
