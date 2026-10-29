// Long video to clips, in the browser: read the MP4/MOV index (mp4box.js), send the sound in
// 16 kHz WAV pieces for timed words, let Dailies pick the moments, then cut each one to 9:16 with
// word-timed captions (WebCodecs decode → canvas → encode → MP4). The video itself never leaves the device.
import { createFile, DataStream } from "https://cdn.jsdelivr.net/npm/mp4box@0.5.3/+esm";
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/build/mp4-muxer.mjs";
import { $, el, call, cards, allBox, sidePanel, pickCodec, pickAudioCodec, encodeAudio, caption, wrap, W, H, FPS } from "./app.js";

const PIECE = 600, RATE = 16000, MAX_MINUTES = 60, WINDOW = 16 * 1048576;
let src = null, words = [], segments = [];

// ---- Reading the file ---------------------------------------------------------

// The top-level boxes, so only ftyp and moov are read, wherever moov sits (start or end).
async function boxes(file) {
  const out = [];
  for (let at = 0; at + 8 <= file.size;) {
    const v = new DataView(await file.slice(at, at + 16).arrayBuffer());
    let size = v.getUint32(0), head = 8;
    const type = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
    if (size === 1) { size = Number(v.getBigUint64(8)); head = 16; } else if (size === 0) size = file.size - at;
    if (size < head) break;
    out.push({ type, at, size });
    at += size;
  }
  return out;
}

async function open(file) {
  const top = await boxes(file);
  const moov = top.find(b => b.type === "moov");
  if (!moov) throw new Error("That isn't an MP4 or MOV video Dailies can read.");
  if (moov.size > 200 * 1048576) throw new Error("This video's index is too large.");
  const ftyp = top.find(b => b.type === "ftyp");
  const parts = await Promise.all([ftyp, moov].filter(Boolean).map(b => file.slice(b.at, b.at + b.size).arrayBuffer()));
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  parts.reduce((at, p) => (buf.set(new Uint8Array(p), at), at + p.byteLength), 0);
  const mp4 = createFile();
  let info = null, failed = null;
  mp4.onReady = i => info = i;
  mp4.onError = e => failed = e;
  buf.buffer.fileStart = 0;
  mp4.appendBuffer(buf.buffer); mp4.flush();
  if (!info) throw new Error(failed ? `Couldn't read the video: ${failed}` : "Couldn't read the video's index.");
  const track = t => {
    if (!t) return null;
    const trak = mp4.getTrackById(t.id), entry = trak.mdia.minf.stbl.stsd.entries[0];
    const elst = trak.edts?.elst?.entries?.find(e => e.media_time >= 0);
    return { info: t, trak, entry, samples: trak.samples, shift: (elst?.media_time || 0) / t.timescale, file };
  };
  const video = track(info.videoTracks[0]), audio = track(info.audioTracks[0]);
  if (!video) throw new Error("There's no video track in that file.");
  const m = video.info.matrix || [65536, 0, 0, 0, 65536];
  const rot = ((Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI) % 360) + 360) % 360;
  const duration = info.duration / info.timescale;
  return { file, video, audio, rot, duration, width: video.info.track_width, height: video.info.track_height };
}

// The bytes of each sample, read from the file in windows of up to 16 MB.
async function* readSamples(file, samples) {
  for (let i = 0; i < samples.length;) {
    const a = samples[i].offset;
    let j = i, end = a;
    while (j < samples.length && samples[j].offset >= a && samples[j].offset + samples[j].size - a <= WINDOW) end = Math.max(end, samples[j].offset + samples[j++].size);
    if (j === i) end = a + samples[j++].size;
    const buf = new Uint8Array(await file.slice(a, end).arrayBuffer());
    for (let k = i; k < j; k++) yield [samples[k], buf.subarray(samples[k].offset - a, samples[k].offset - a + samples[k].size)];
    i = j;
  }
}

const time = (t, s) => s.cts / s.timescale - t.shift;

function description(entry) {
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  if (box) { const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); box.write(s); return new Uint8Array(s.buffer, 8); }
  const asc = entry.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
  return asc ? new Uint8Array(asc) : undefined;
}

// Decode a track's samples that cover [from, to] seconds, starting at the key sample before `from`.
// The decoder and its settings for a track, or a plain-words error if this browser can't read it.
// iPhones record HEVC ("High Efficiency") by default, and some browsers can't decode it.
async function decoderFor(t, kind) {
  const Dec = kind === "video" ? VideoDecoder : AudioDecoder;
  const config = kind === "video"
    ? { codec: t.info.codec, codedWidth: t.info.video?.width || t.info.track_width, codedHeight: t.info.video?.height || t.info.track_height, description: description(t.entry) }
    : { codec: t.info.codec.replace(/^mp4a\.40\.0*/, "mp4a.40."), sampleRate: t.info.audio.sample_rate, numberOfChannels: t.info.audio.channel_count, description: description(t.entry) };
  if (!(await Dec.isConfigSupported(config).catch(() => ({}))).supported)
    throw new Error(kind === "video" ? `This browser can't decode this video (${t.info.codec}). ${HEVC.test(t.info.codec) ? IPHONE : "Try Chrome, or export it as H.264."}` : `This browser can't decode this video's sound (${t.info.codec}).`);
  return [Dec, config];
}
const HEVC = /^(hvc1|hev1)/;
const IPHONE = "It's HEVC, the iPhone's default. Try it in Safari, or in Chrome on a Mac or Windows PC. To record in a format that works everywhere: iPhone Settings → Camera → Formats → Most Compatible.";

async function decode(t, kind, from, to, onOutput, between) {
  const ss = t.samples;
  let first = ss.findIndex(s => time(t, s) + s.duration / s.timescale > from);
  if (first < 0) return;
  if (kind === "video") while (first > 0 && !ss[first].is_sync) first--;
  else first = Math.max(0, first - 2); // AAC needs a frame or two to settle
  let last = ss.length;
  for (let i = first; i < ss.length; i++) if (time(t, ss[i]) > to + (kind === "video" ? 1 : 0.1)) { last = i; break; }
  let failed = null;
  const [Dec, config] = await decoderFor(t, kind);
  const dec = new Dec({ output: onOutput, error: e => failed = e });
  dec.configure(config);
  const Chunk = kind === "video" ? EncodedVideoChunk : EncodedAudioChunk;
  for await (const [s, data] of readSamples(t.file, ss.slice(first, last))) {
    if (failed) throw failed;
    dec.decode(new Chunk({ type: s.is_sync || kind === "audio" ? "key" : "delta", timestamp: Math.round(time(t, s) * 1e6), duration: Math.round(s.duration * 1e6 / s.timescale), data }));
    while (dec.decodeQueueSize > 12) await new Promise(r => setTimeout(r, 1));
    if (between) await between();
  }
  await dec.flush(); dec.close();
  if (failed) throw failed;
}

// ---- Words with times ---------------------------------------------------------

function wav(samples) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2)), str = (at, s) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 32767, true));
  return out.buffer;
}

// The soundtrack up to `to`, downmixed and box-filtered to 16 kHz mono, sent in 10-minute pieces.
async function listen(s, progress, to = s.duration) {
  const a = s.audio;
  if (!a) throw new Error("This video has no sound, so there's nothing to pick moments from.");
  const ratio = a.info.audio.sample_rate / RATE, piece = new Float32Array(PIECE * RATE), ready = [], all = { words: [], segments: [] };
  let n = 0, sent = 0, sum = 0, cnt = 0, inPos = 0, next = ratio, t0 = null;
  const pieces = Math.ceil(to / PIECE);
  const send = async (samples, at) => {
    progress(`Listening… part ${++sent} of ${pieces}`);
    const r = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav(samples) });
    const d = await r.json().catch(() => ({ error: `Dailies answered ${r.status}.` }));
    if (!r.ok || d.error) throw new Error(d.error);
    all.words.push(...d.words.map(w => ({ ...w, s: w.s + at, e: w.e + at })));
    all.segments.push(...d.segments.map(g => ({ ...g, s: g.s + at, e: g.e + at })));
  };
  await decode(a, "audio", 0, to, data => {
    t0 ??= Math.max(0, data.timestamp / 1e6);
    const ch = data.numberOfChannels, len = data.numberOfFrames, planes = [];
    for (let c = 0; c < ch; c++) { const p = new Float32Array(len); data.copyTo(p, { planeIndex: c, format: "f32-planar" }); planes.push(p); }
    data.close();
    for (let i = 0; i < len; i++) {
      let x = 0; for (let c = 0; c < ch; c++) x += planes[c][i];
      sum += x / ch; cnt++;
      if (++inPos >= next) {
        piece[n++] = sum / cnt; sum = cnt = 0; next += ratio;
        if (n === piece.length) { ready.push(piece.slice()); n = 0; }
      }
    }
  }, async () => { while (ready.length) await send(ready.shift(), t0 + (sent) * PIECE); });
  while (ready.length) await send(ready.shift(), t0 + sent * PIECE);
  if (n > RATE / 2) await send(piece.slice(0, n), t0 + sent * PIECE);
  return all;
}

// ---- Drawing a frame ------------------------------------------------------------

const small = Object.assign(document.createElement("canvas"), { width: 54, height: 96 });

// Draw the frame, turned upright, into the box (x, y, w, h).
function put(ctx, f, x, y, w, h, r = src.rot) {
  ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(r * Math.PI / 180);
  const [dw, dh] = r % 180 ? [h, w] : [w, h];
  ctx.drawImage(f, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function drawFrame(ctx, f, clip, t) {
  const [sw, sh] = src.rot % 180 ? [f.displayHeight, f.displayWidth] : [f.displayWidth, f.displayHeight];
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  if (clip.layout === "fill") {
    const s = Math.max(W / sw, H / sh);
    put(ctx, f, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
  } else {
    // A blurred copy behind (drawn tiny, then scaled up), the whole frame on top, the title above.
    const b = small.getContext("2d"), bs = Math.max(small.width / sw, small.height / sh);
    put(b, f, (small.width - sw * bs) / 2, (small.height - sh * bs) / 2, sw * bs, sh * bs);
    ctx.imageSmoothingQuality = "high"; ctx.drawImage(small, 0, 0, W, H);
    ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / sw, (H * 0.62) / sh), w = sw * s, h = sh * s;
    put(ctx, f, (W - w) / 2, H * 0.45 - h / 2, w, h);
    if (clip.title) {
      ctx.font = "800 76px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const lines = wrap(ctx, clip.title, W - 140, true).slice(0, 3), top = H * 0.45 - h / 2 - 60 - (lines.length - 1) * 88;
      lines.forEach((l, i) => { ctx.lineWidth = 10; ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.lineJoin = "round"; ctx.strokeText(l, W / 2, top + i * 88); ctx.fillStyle = "#fff"; ctx.fillText(l, W / 2, top + i * 88); });
    }
  }
  if (clip.captions) {
    const c = clip.lines.findLast(c => c.s <= t);
    if (c && t < c.e + 0.6) caption(ctx, c.text, (t - c.s));
  }
}

// The clip's words in caption chunks of up to 3 words, times relative to the clip.
function lines(clip, from = words) {
  const ws = from.filter(w => w.s >= clip.start - 0.05 && w.e <= clip.end + 0.3), out = [];
  let cur = null;
  for (const w of ws) {
    const text = w.w.trim();
    if (!cur || cur.n >= 3 || (cur.text + " " + text).length > 18 || w.s - clip.start - cur.e > 0.6) out.push(cur = { s: w.s - clip.start, e: w.e - clip.start, text, n: 1 });
    else { cur.text += " " + text; cur.e = w.e - clip.start; cur.n++; }
  }
  return out;
}

// ---- Rendering a clip ---------------------------------------------------------------

// The source's sound between start and end, faded in and out, as 48 kHz stereo ready to encode; null if it has none.
async function sound(s, start, end) {
  if (!s.audio) return null;
  const seconds = end - start, parts = [];
  let rate = 48000, chans = 2;
  await decode(s.audio, "audio", start - 0.5, end + 0.2, data => {
    rate = data.sampleRate; chans = data.numberOfChannels;
    const planes = Array.from({ length: chans }, (_, c) => { const p = new Float32Array(data.numberOfFrames); data.copyTo(p, { planeIndex: c, format: "f32-planar" }); return p; });
    parts.push({ at: data.timestamp / 1e6, planes }); data.close();
  });
  if (!parts.length) return null;
  const len = parts.reduce((n, p) => n + p.planes[0].length, 0), buf = new AudioBuffer({ length: len, sampleRate: rate, numberOfChannels: chans });
  let at = 0; for (const p of parts) { p.planes.forEach((pl, c) => buf.copyToChannel(pl, c, at)); at += p.planes[0].length; }
  const off = new OfflineAudioContext(2, Math.ceil(seconds * 48000), 48000), node = off.createBufferSource(), g = off.createGain();
  node.buffer = buf;
  g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, 0.1); g.gain.setValueAtTime(1, Math.max(0.1, seconds - 0.25)); g.gain.linearRampToValueAtTime(0, seconds);
  node.connect(g).connect(off.destination);
  node.start(0, Math.max(0, start - parts[0].at));
  return { ...(await pickAudioCodec()), audio: await off.startRendering() };
}

async function cut(canvas, clip, progress) {
  const { config, mux } = await pickCodec();
  const ctx = canvas.getContext("2d"), frames = Math.round((clip.end - clip.start) * FPS);
  clip.lines = lines(clip);
  progress(0, "Cutting the sound…");
  const snd = await sound(src, clip.start, clip.end);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: mux, width: W, height: H, frameRate: FPS },
    ...(snd && { audio: { codec: snd.mux, sampleRate: 48000, numberOfChannels: 2 } }), fastStart: "in-memory" });
  let failed = null, k = 0, prev = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => failed = e });
  enc.configure(config);
  const emit = f => {
    drawFrame(ctx, f, clip, k / FPS);
    const out = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(out, { keyFrame: k % (FPS * 2) === 0 }); out.close(); k++;
  };
  // Each output frame (30 a second) shows the latest source frame at or before its time.
  await decode(src.video, "video", clip.start, clip.end, f => {
    const ts = f.timestamp / 1e6;
    while (k < frames && clip.start + k / FPS < ts) emit(prev || f);
    prev?.close(); prev = f;
  }, async () => {
    if (failed) throw failed;
    while (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
    progress(k / frames);
  });
  while (prev && k < frames) emit(prev);
  prev?.close();
  await enc.flush();
  if (failed) throw failed;
  if (snd) await encodeAudio(muxer, snd.audio, snd.config);
  muxer.finalize();
  progress(1);
  const blob = new Blob([target.buffer], { type: "video/mp4" });
  blob.vp9 = mux === "vp9"; blob.opus = snd?.mux === "opus";
  return blob;
}

// For you.js, which lays a creator's video over the page.
export { open, decode, decoderFor, listen, put, sound, lines };

async function still(canvas, clip) {
  const at = clip.start + 0.5;
  let best = null;
  await decode(src.video, "video", at, at, f => { if (f.timestamp / 1e6 <= at || !best) { best?.close(); best = f; } else f.close(); });
  if (best) { clip.lines = lines(clip); drawFrame(canvas.getContext("2d"), best, clip, 0.5); best.close(); }
}

// ---- The page -----------------------------------------------------------------------

const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const say = (msg, bad) => { $("clipStatus").textContent = msg; $("clipStatus").className = "status small" + (bad ? " bad" : ""); };

$("clipFile").onchange = async () => {
  const f = $("clipFile").files[0]; src = null; $("clipBtn").disabled = true; $("clipInfo").textContent = "";
  $("clipName").textContent = f ? f.name : "or drop it here";
  if (!f) return;
  say("Reading the video…");
  try {
    if (!("VideoDecoder" in window)) throw new Error("This browser can't cut video. Use Chrome or Edge.");
    src = await open(f);
    await decoderFor(src.video, "video").catch(e => { src = null; throw e; });
    if (src.duration > MAX_MINUTES * 60) { const m = Math.round(src.duration / 60); src = null; throw new Error(`Up to ${MAX_MINUTES} minutes for now. This one is ${m}.`); }
    const up = src.rot % 180 ? [src.height, src.width] : [src.width, src.height];
    $("clipInfo").textContent = `${mmss(src.duration)} long · ${up[0]}×${up[1]}${src.audio ? "" : " · no sound"}`;
    $("clipCount").value = String(Math.max(1, Math.min(10, Math.round(src.duration / 120)) || 1));
    $("clipBtn").disabled = false; say("");
  } catch (err) { say(err.message, true); }
};

// A video dropped on the picker counts as picked.
const drop = $("clipDrop");
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = e => {
  e.preventDefault(); drop.classList.remove("over");
  if (!e.dataTransfer.files.length || $("clipFile").disabled) return;
  $("clipFile").files = e.dataTransfer.files; $("clipFile").dispatchEvent(new Event("change"));
};

$("clipBtn").onclick = async () => {
  $("clipBtn").disabled = true; $("clipFile").disabled = true;
  try {
    const heard = await listen(src, msg => say(msg));
    ({ words, segments } = heard);
    say("Picking the best moments… (about 10–30 seconds)");
    const { clips } = await call("/api/moments", { segments: heard.segments, duration: src.duration, count: +$("clipCount").value });
    if (!clips.length) throw new Error("No stand-alone moments were found in this video.");
    // Start and end at the longest pause near the picked times (whisper's words carry no punctuation).
    const pause = i => i <= 0 ? 99 : words[i].s - words[i - 1].e, after = i => i >= words.length - 1 ? 99 : words[i + 1].s - words[i].e;
    const best = (lo, hi, score, key) => words.map((w, i) => [i, w[key]]).filter(([, t]) => t >= lo && t <= hi).sort((a, b) => score(b[0]) - score(a[0]))[0];
    for (const c of clips) {
      const a = best(c.start - 3, c.start + 1.5, pause, "s"), b = best(c.end - 1.5, c.end + 3, after, "e");
      if (a) c.start = Math.max(0, words[a[0]].s - 0.15);
      if (b && words[b[0]].e > c.start + 5) c.end = Math.min(src.duration, words[b[0]].e + 0.35);
    }
    clips.forEach((c, i) => { if (i && c.start < clips[i - 1].end) c.start = clips[i - 1].end; });
    say(clips.length < +$("clipCount").value ? `${clips.length} good moment${clips.length === 1 ? "" : "s"} found.` : "");
    cards.length = 0; $("allTicks").replaceChildren(); $("allOut").replaceChildren();
    const layout = (src.rot % 180 ? src.width < src.height : src.width > src.height) ? "fit" : "fill";
    const made = clips.map((c, i) => clipCard({ ...c, layout, captions: true, angle: c.title }, i));
    $("videos").replaceChildren(...made.map(m => m.card)); allBox();
    for (const m of made) await m.still();
  } catch (err) { say(err.message, true); }
  $("clipBtn").disabled = false; $("clipFile").disabled = false;
};

function clipCard(v, n) {
  // What was said, from the speech-to-text's punctuated sentences; two lines until it's clicked.
  const said = () => segments.filter(g => g.e > v.start + 0.2 && g.s < v.end - 0.2).map(g => g.t.trim()).join(" ");
  const quote = el("p", { className: "quote note", title: "Show it all", tabIndex: 0, onclick() { this.classList.toggle("open"); }, onkeydown(e) { if (e.key === "Enter") this.click(); } });
  const span = el("span", { className: "small muted" });
  const showQuote = () => { quote.textContent = `“${said()}”`; span.textContent = `${mmss(v.start)}–${mmss(v.end)} · ${Math.round(v.end - v.start)} s`; };
  const num = (key, label) => el("label", { className: "f" }, label, el("input", { type: "number", step: 0.1, min: 0, max: src.duration, value: v[key].toFixed(1),
    onchange() { const x = +this.value; if (key === "start" ? x < v.end - 1 : x > v.start + 1) { v[key] = Math.max(0, Math.min(src.duration, x)); showQuote(); redraw(); } else this.value = v[key].toFixed(1); } }));
  const head = el("h3", { textContent: v.title });
  const title = el("input", { type: "text", value: v.title, maxLength: 100, oninput() { v.title = this.value; head.textContent = this.value; } });
  const cap = el("textarea", { value: v.caption, rows: 3, oninput() { v.caption = this.value; } });
  const hashtags = el("input", { type: "text", value: (v.hashtags || []).map(t => "#" + t).join(" "), oninput() { v.hashtags = this.value.split(/[\s,#]+/).filter(Boolean); } });
  const layout = el("select", { onchange() { v.layout = this.value; redraw(); } },
    el("option", { value: "fit", textContent: "Fit: whole picture, blurred behind", selected: v.layout === "fit" }),
    el("option", { value: "fill", textContent: "Fill: crop to the middle", selected: v.layout === "fill" }));
  const caps = el("input", { type: "checkbox", checked: true, onchange() { v.captions = this.checked; redraw(); } });
  const canvas = el("canvas", { width: W, height: H, className: "preview" });
  const state = { v, music: { set() {} }, mp4: null, uploaded: null };
  cards.push(state);
  const redraw = () => still(canvas, v).catch(() => {});
  const side = sidePanel(canvas);
  const card = el("div", { className: "card" },
    el("div", { className: "vhead" }, el("span", { className: "badge gold", textContent: `Clip ${n + 1}` }), head, span),
    el("div", { className: "video" },
      el("div", {}, quote,
        el("div", { className: "grp", textContent: "The cut" }),
        el("div", { className: "times" }, num("start", "Start (s)"), num("end", "End (s)")),
        el("label", { className: "f" }, "Layout", layout),
        el("div", { style: "margin-top:12px" }, el("label", { className: "ch" }, caps, "Captions from the words spoken")),
        el("div", { className: "grp", textContent: "Post" }),
        el("label", { className: "f" }, "Title (on the clip in Fit, and for YouTube and TikTok)", title),
        el("label", { className: "f" }, "Caption", cap),
        el("label", { className: "f" }, "Hashtags", hashtags)),
      side.box));
  showQuote();
  state.render = () => side.render(state, (p, msg) => msg || `Cutting… ${Math.round(p * 100)}%`, progress => cut(canvas, v, progress), `dailies-clip-${n + 1}.mp4`,
    mp4 => mp4.size > 25 * 1048576 ? "Over 25 MB, so it can't be drafted from here. Shorten it." : "");
  side.btn.onclick = () => state.render();
  return { card, still: redraw };
}
