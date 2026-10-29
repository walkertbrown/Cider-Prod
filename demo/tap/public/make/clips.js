// Long video to clips, in the browser: read the MP4/MOV index (mp4box.js), send the sound in
// 16 kHz WAV pieces for timed words, let Dailies pick the moments, then cut each one to 9:16 with
// word-timed captions (WebCodecs decode → canvas → encode → MP4). The video itself never leaves the device.
import { createFile, DataStream } from "https://cdn.jsdelivr.net/npm/mp4box@0.5.3/+esm";
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/build/mp4-muxer.mjs";
import { $, el, call, cards, allBox, sidePanel, pickCodec, pickAudioCodec, encodeAudio, caption, captionPick, hotWord, wrap, W, H, FPS } from "./app.js";
import { getSegmenter, tick } from "./seg.js";

const PIECE = 600, RATE = 16000, MAX_MINUTES = 60, WINDOW = 16 * 1048576, LOUD = 50; // loudness readings a second
let src = null, words = [], segments = [], env = null;

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
  // A recording made in a browser is fragmented: its index names no samples, each fragment does. Then it is read whole.
  let iso = mp4;
  if (info.isFragmented && !mp4.getTrackById(info.videoTracks[0]?.id)?.samples.length) {
    if (file.size > 300 * 1048576) throw new Error("This recording is too large to read here (over 300 MB).");
    const all = await file.arrayBuffer(); all.fileStart = 0;
    iso = createFile(); info = null; iso.onReady = i => info = i; iso.onError = e => failed = e;
    iso.appendBuffer(all); iso.flush();
    if (!info) throw new Error(failed ? `Couldn't read the recording: ${failed}` : "Couldn't read the recording.");
  }
  const track = t => {
    if (!t) return null;
    const trak = iso.getTrackById(t.id), entry = trak.mdia.minf.stbl.stsd.entries[0];
    const elst = trak.edts?.elst?.entries?.find(e => e.media_time >= 0);
    return { info: t, trak, entry, samples: trak.samples, shift: (elst?.media_time || 0) / t.timescale, file };
  };
  const video = track(info.videoTracks[0]), audio = track(info.audioTracks[0]);
  if (!video) throw new Error("There's no video track in that file.");
  const m = video.info.matrix || [65536, 0, 0, 0, 65536];
  const rot = ((Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI) % 360) + 360) % 360;
  const last = video.samples.at(-1);
  const duration = info.duration / info.timescale || (last ? (last.cts + last.duration) / last.timescale - video.shift : 0);
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
    : { codec: t.info.codec.replace(/^mp4a\.40\.0*/, "mp4a.40.").replace(/^opus$/i, "opus"), sampleRate: t.info.audio.sample_rate, numberOfChannels: t.info.audio.channel_count, description: description(t.entry) };
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

// The soundtrack up to `to`, downmixed and box-filtered to 16 kHz mono, sent in 10-minute pieces. Its loudness is kept
// too, 50 times a second in dB, for finding the pauses.
async function listen(s, progress, to = s.duration) {
  const a = s.audio;
  if (!a) throw new Error("This video has no sound, so there's nothing to pick moments from.");
  const ratio = a.info.audio.sample_rate / RATE, piece = new Float32Array(PIECE * RATE), ready = [], all = { words: [], segments: [] };
  let n = 0, sent = 0, sum = 0, cnt = 0, inPos = 0, next = ratio, t0 = null, sq = 0, sqn = 0;
  const loud = [], per = RATE / LOUD;
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
        const y = sum / cnt; piece[n++] = y; sum = cnt = 0; next += ratio;
        sq += y * y; if (++sqn === per) { loud.push(10 * Math.log10(sq / per + 1e-10)); sq = sqn = 0; }
        if (n === piece.length) { ready.push(piece.slice()); n = 0; }
      }
    }
  }, async () => { while (ready.length) await send(ready.shift(), t0 + (sent) * PIECE); });
  while (ready.length) await send(ready.shift(), t0 + sent * PIECE);
  if (n > RATE / 2) await send(piece.slice(0, n), t0 + sent * PIECE);
  return { ...all, env: { rate: LOUD, t0: t0 || 0, db: Float32Array.from(loud) } };
}

// ---- Cutting the dead air -------------------------------------------------------------

// The stretches of [from, to] to keep: a pause (quiet for over half a second, by the take's own loudness) is cut down
// to a fifth of a second, and quiet before the first word and after the last goes. Quiet is measured against this
// take: 30% of the way from its room noise up to its speaking level. No cut goes through the middle of a word the
// speech-to-text heard. With no loudness to go on, it's all kept.
function pauses(loudness, ws, from, to) {
  const whole = Object.assign([{ a: from, b: to }], { cut: 0, saved: 0 });
  const R = loudness?.rate, db0 = loudness?.db;
  if (!db0?.length) return whole;
  const i0 = Math.max(0, Math.floor((from - loudness.t0) * R)), i1 = Math.min(db0.length, Math.ceil((to - loudness.t0) * R));
  if (i1 - i0 < R) return whole;
  const db = db0.subarray(i0, i1), sorted = Float32Array.from(db).sort(), heard = sorted.filter(x => x > -90); // a muted stretch says nothing of the room
  if (heard.length < R) return whole;
  const at = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))], floor = at(heard, 0.05), voice = at(sorted, 0.9);
  if (voice - floor < 10) return whole; // too even to tell talk from pause
  const quiet = Math.min(floor + (voice - floor) * 0.3, voice - 12), T = i => loudness.t0 + (i0 + i) / R;
  // Runs of quiet, carried over blips of up to 40 ms (a click, a breath out).
  let runs = [], a = -1, last = -1;
  for (let i = 0; i < db.length; i++) if (db[i] < quiet) { if (a < 0 || i - last > 3) { if (a >= 0) runs.push([T(a), T(last + 1)]); a = i; } last = i; }
  if (a >= 0) runs.push([T(a), T(last + 1)]);
  // The middle of each word that was heard is never cut (a word over 0.8 s long was stretched over a pause by the speech-to-text).
  for (const w of ws) {
    const d = w.e - w.s; if (d <= 0 || d > 0.8 || w.e < from || w.s > to) continue;
    const ca = w.s + d * 0.3, cb = w.e - d * 0.3;
    runs = runs.flatMap(([ra, rb]) => cb <= ra || ca >= rb ? [[ra, rb]] : [[ra, ca], [cb, rb]].filter(([x, y]) => y > x));
  }
  const cuts = [];
  for (const [ra, rb] of runs) {
    const head = ra <= from + 0.05, tail = rb >= to - 0.05;
    if (head && tail) continue;
    if (head) { if (rb - from > 0.4) cuts.push([from, rb - 0.15]); }
    else if (tail) { if (to - ra > 0.4) cuts.push([ra + 0.25, to]); }
    else if (rb - ra >= 0.5) cuts.push([ra + 0.12, rb - 0.08]);
  }
  const keeps = []; let k = from;
  for (const [ca, cb] of cuts) { if (ca - k > 0.04) keeps.push({ a: k, b: ca }); k = Math.max(k, cb); }
  if (to - k > 0.04) keeps.push({ a: k, b: to });
  const kept = keeps.reduce((n, x) => n + x.b - x.a, 0);
  if (kept < 1) return whole;
  return Object.assign(keeps, { cut: cuts.filter(([ca, cb]) => ca > from && cb < to).length, saved: to - from - kept });
}

// The clock of a video with stretches cut out: output time (from 0) to source time and back, and which kept stretch it's in.
function timeMap(keeps) {
  let at = 0;
  const ks = keeps.map(k => { const o = { a: k.a, b: k.b, o: at }; at += k.b - k.a; return o; });
  return {
    dur: at, keeps: ks,
    toSrc: t => { const k = ks.findLast(k => k.o <= t) || ks[0]; return Math.min(k.b, k.a + t - k.o); },
    toOut: x => { const k = ks.find(k => x < k.b); return k ? k.o + Math.max(0, x - k.a) : at; },
    seg: t => Math.max(0, ks.findLastIndex(k => k.o <= t)),
  };
}
const mapFor = (clip, ws = words, loudness = env) => timeMap(clip.tight === false ? [{ a: clip.start, b: clip.end }] : pauses(loudness, ws, clip.start, clip.end));

// ---- Drawing a frame ------------------------------------------------------------

const small = Object.assign(document.createElement("canvas"), { width: 54, height: 96 });

// Draw the frame, turned upright, into the box (x, y, w, h).
function put(ctx, f, x, y, w, h, r = src.rot) {
  ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(r * Math.PI / 180);
  const [dw, dh] = r % 180 ? [h, w] : [w, h];
  ctx.drawImage(f, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

// `look` is where the picture is aimed: x is the point across the source (0 to 1) kept in the middle of a Fill frame,
// z the zoom, which steps in and out at each cut pause so a jump cut reads as an edit.
function drawFrame(ctx, f, clip, t, look = { x: 0.5, z: 1 }) {
  const [sw, sh] = src.rot % 180 ? [f.displayHeight, f.displayWidth] : [f.displayWidth, f.displayHeight];
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  if (clip.layout === "fill" || clip.layout === "middle") {
    const s = Math.max(W / sw, H / sh) * look.z, dw = sw * s, dh = sh * s;
    put(ctx, f, Math.min(0, Math.max(W - dw, W / 2 - look.x * dw)), (H - dh) * 0.4, dw, dh);
  } else {
    // A blurred copy behind (drawn tiny, then scaled up), the whole frame on top, the title above.
    const b = small.getContext("2d"), bs = Math.max(small.width / sw, small.height / sh);
    put(b, f, (small.width - sw * bs) / 2, (small.height - sh * bs) / 2, sw * bs, sh * bs);
    ctx.imageSmoothingQuality = "high"; ctx.drawImage(small, 0, 0, W, H);
    ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / sw, (H * 0.62) / sh), w = sw * s, h = sh * s, x = (W - w) / 2, y = H * 0.45 - h / 2, z = look.z;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    put(ctx, f, x - w * (z - 1) / 2, y - h * (z - 1) / 2, w * z, h * z); ctx.restore();
    if (clip.title) {
      ctx.font = "800 76px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const lines = wrap(ctx, clip.title, W - 140, true).slice(0, 3), top = H * 0.45 - h / 2 - 60 - (lines.length - 1) * 88;
      lines.forEach((l, i) => { ctx.lineWidth = 10; ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.lineJoin = "round"; ctx.strokeText(l, W / 2, top + i * 88); ctx.fillStyle = "#fff"; ctx.fillText(l, W / 2, top + i * 88); });
    }
  }
  if (clip.captions) {
    const c = clip.lines.findLast(c => c.s <= t);
    if (c && t < c.e + 0.6) caption(ctx, c.text, t - c.s, H * 0.66, clip.pop !== false ? hotWord(c, t) : null);
  }
}

// ---- Following the person -------------------------------------------------------------

// Where the person is across an upright frame, 0 to 1: the middle of their head, from the selfie segmenter on a small
// copy. The biggest figure wins when there are two; null when no one is there.
function finder(seg, uw, uh) {
  const k = 256 / Math.max(uw, uh), work = new OffscreenCanvas(Math.max(16, Math.round(uw * k)), Math.max(16, Math.round(uh * k)));
  const wctx = work.getContext("2d", { willReadFrequently: true });
  return f => {
    put(wctx, f, 0, 0, work.width, work.height);
    const r = seg.segmentForVideo(work, tick(2)), m = r.confidenceMasks[r.confidenceMasks.length - 1], w = m.width, h = m.height, d = m.getAsFloat32Array();
    try {
      const cols = new Float32Array(w); let total = 0;
      for (let i = 0; i < d.length; i++) if (d[i] > 0.5) { cols[i % w]++; total++; }
      if (total < w * h * 0.015) return null;
      // Runs of columns someone is in; the one with the most of them is the person.
      let best = null, a = -1, sum = 0;
      for (let x = 0; x <= w; x++) {
        if (x < w && cols[x] > h * 0.02) { if (a < 0) { a = x; sum = 0; } sum += cols[x]; }
        else if (a >= 0) { if (!best || sum > best.sum) best = { a, b: x, sum }; a = -1; }
      }
      if (!best) return null;
      // Their head: the top fifth of the frame from the highest point they reach.
      let top = -1;
      for (let y = 0; y < h && top < 0; y++) for (let x = best.a; x < best.b; x++) if (d[y * w + x] > 0.5) { top = y; break; }
      let sx = 0, n = 0;
      for (let y = top; y < Math.min(h, top + h * 0.2); y++) for (let x = best.a; x < best.b; x++) if (d[y * w + x] > 0.5) { sx += x; n++; }
      return (n ? sx / n + 0.5 : (best.a + best.b) / 2) / w;
    } finally { r.close(); }
  };
}

let finding = null;
const finderFor = (s, progress) => (finding ??= getSegmenter(progress, "Loading the person finder (once, about 10 MB)…").catch(e => { finding = null; throw e; }))
  .then(seg => finder(seg, ...(s.rot % 180 ? [s.height, s.width] : [s.width, s.height])));

// The source frame shown at `at` seconds (the latest at or before it). The caller closes it.
async function frameAt(at) {
  let best = null;
  await decode(src.video, "video", at, at, f => { if (f.timestamp / 1e6 <= at || !best) { best?.close(); best = f; } else f.close(); });
  return best;
}

// Is someone in the picture? Asked of three frames; two will do.
async function someone() {
  const find = await finderFor(src, (p, msg) => say(msg)).catch(() => null);
  if (!find) return false;
  let n = 0;
  for (const p of [0.25, 0.5, 0.75]) { const f = await frameAt(src.duration * p); if (f) { if (find(f) != null) n++; f.close(); } }
  return n >= 2;
}

// Whether a Fill frame has room to move across the source (a wide video does; a phone video doesn't).
const roomToMove = clip => { const [sw, sh] = src.rot % 180 ? [src.height, src.width] : [src.width, src.height]; return clip.layout === "fill" && sw * Math.max(W / sw, H / sh) - W > 4; };

// The clip's words in caption chunks of up to 3 words, each word with its time, on the clip's own clock (which skips
// any pauses cut out, when a time map is given).
function lines(clip, from = words, map = null) {
  const at = map ? x => map.toOut(x) : x => x - clip.start;
  const ws = from.filter(w => w.s >= clip.start - 0.05 && w.e <= clip.end + 0.3), out = [];
  let cur = null;
  for (const w of ws) {
    const text = w.w.trim().replace(/\s+/g, "-"), s = at(w.s), e = Math.max(s + 0.05, at(w.e));
    if (!text) continue;
    if (!cur || cur.ws.length >= 3 || (cur.text + " " + text).length > 18 || s - cur.e > 0.6) out.push(cur = { s, e, text, ws: [{ s, e }] });
    else { cur.text += " " + text; cur.e = e; cur.ws.push({ s, e }); }
  }
  return out;
}

// ---- Rendering a clip ---------------------------------------------------------------

// The source's sound between start and end, faded in and out, as 48 kHz stereo ready to encode; null if it has none.
// With `keeps`, only those stretches, laid end to end, each join faded over 15 ms so it doesn't click.
async function sound(s, start, end, keeps = [{ a: start, b: end }]) {
  if (!s.audio) return null;
  const seconds = keeps.reduce((n, k) => n + k.b - k.a, 0), parts = [];
  let rate = 48000, chans = 2;
  await decode(s.audio, "audio", start - 0.5, end + 0.2, data => {
    rate = data.sampleRate; chans = data.numberOfChannels;
    const planes = Array.from({ length: chans }, (_, c) => { const p = new Float32Array(data.numberOfFrames); data.copyTo(p, { planeIndex: c, format: "f32-planar" }); return p; });
    parts.push({ at: data.timestamp / 1e6, planes }); data.close();
  });
  if (!parts.length) return null;
  const len = parts.reduce((n, p) => n + p.planes[0].length, 0), buf = new AudioBuffer({ length: len, sampleRate: rate, numberOfChannels: chans });
  let at = 0; for (const p of parts) { p.planes.forEach((pl, c) => buf.copyToChannel(pl, c, at)); at += p.planes[0].length; }
  const off = new OfflineAudioContext(2, Math.ceil(seconds * 48000), 48000);
  let o = 0;
  keeps.forEach((k, i) => {
    const len = k.b - k.a, node = off.createBufferSource(), g = off.createGain();
    const fin = Math.min(len / 3, i ? 0.015 : 0.1), fout = Math.min(len / 3, i < keeps.length - 1 ? 0.015 : 0.25);
    node.buffer = buf;
    g.gain.setValueAtTime(0, o); g.gain.linearRampToValueAtTime(1, o + fin); g.gain.setValueAtTime(1, o + len - fout); g.gain.linearRampToValueAtTime(0, o + len);
    node.connect(g).connect(off.destination);
    node.start(o, Math.max(0, k.a - parts[0].at), len);
    o += len;
  });
  return { ...(await pickAudioCodec()), audio: await off.startRendering() };
}

async function cut(canvas, clip, progress) {
  const { config, mux } = await pickCodec();
  const map = mapFor(clip), ctx = canvas.getContext("2d"), frames = Math.round(map.dur * FPS);
  clip.lines = lines(clip, words, map);
  const find = roomToMove(clip) ? await finderFor(src, progress).catch(() => null) : null;
  progress(0, "Cutting the sound…");
  const snd = await sound(src, clip.start, clip.end, map.keeps);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: mux, width: W, height: H, frameRate: FPS },
    ...(snd && { audio: { codec: snd.mux, sampleRate: 48000, numberOfChannels: 2 } }), fastStart: "in-memory" });
  let failed = null, k = 0, prev = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => failed = e });
  enc.configure(config);
  // The aim glides after the person (about half a second to catch up) once they're 5% of the source's width off it,
  // and jumps at a cut. The person is looked for 4 times a second, and on the first frame after each cut.
  const cam = { x: null, aim: null, g: -1 }, seen = { x: null, at: -1 };
  const emit = f => {
    const t = k / FPS, g = map.seg(t);
    if (find) {
      if (seen.x != null && (cam.aim == null || g !== cam.g || Math.abs(seen.x - cam.aim) > 0.05)) cam.aim = seen.x;
      cam.x = cam.x == null || g !== cam.g ? cam.aim ?? 0.5 : cam.x + ((cam.aim ?? cam.x) - cam.x) * 0.06;
    }
    cam.g = g;
    drawFrame(ctx, f, clip, t, { x: find ? cam.x : 0.5, z: g % 2 ? 1.08 : 1 });
    const out = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(out, { keyFrame: k % (FPS * 2) === 0 }); out.close(); k++;
  };
  // Each output frame (30 a second) shows the latest source frame at or before its time on the source's clock.
  await decode(src.video, "video", clip.start, clip.end, f => {
    const ts = f.timestamp / 1e6;
    if (find && (ts - seen.at >= 0.25 || map.keeps.some(c => ts >= c.a && seen.at < c.a))) { seen.x = find(f) ?? seen.x; seen.at = ts; }
    while (k < frames && map.toSrc(k / FPS) < ts) emit(prev || f);
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
export { open, decode, decoderFor, listen, put, sound, lines, pauses, timeMap };

// The preview: a second in, a word being said.
async function still(canvas, clip) {
  const map = mapFor(clip), t = Math.min(1, map.dur / 2), best = await frameAt(map.toSrc(t));
  if (!best) return;
  try {
    clip.lines = lines(clip, words, map);
    const find = roomToMove(clip) ? await finderFor(src, (p, msg) => say(msg)).catch(() => null) : null;
    drawFrame(canvas.getContext("2d"), best, clip, t, { x: find?.(best) ?? 0.5, z: 1 });
    if (find) say("");
  } finally { best.close(); }
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
    ({ words, segments, env } = heard);
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
    // A wide video is cropped to follow the person when there is one, and shown whole when not (a screen recording, say).
    const wide = src.rot % 180 ? src.width < src.height : src.width > src.height;
    if (wide) say("Looking for a person in the picture…");
    const layout = !wide || await someone() ? "fill" : "fit";
    say(clips.length < +$("clipCount").value ? `${clips.length} good moment${clips.length === 1 ? "" : "s"} found.` : "");
    cards.length = 0; $("allTicks").replaceChildren(); $("allOut").replaceChildren();
    const made = clips.map((c, i) => clipCard({ ...c, layout, captions: true, pop: true, tight: true, angle: c.title }, i));
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
    el("option", { value: "fill", textContent: "Fill: crop, following the person", selected: v.layout === "fill" }),
    el("option", { value: "middle", textContent: "Fill: crop to the middle", selected: v.layout === "middle" }),
    el("option", { value: "fit", textContent: "Fit: whole picture, blurred behind", selected: v.layout === "fit" }));
  const gaps = el("span", { className: "small muted" });
  const tight = el("input", { type: "checkbox", checked: v.tight !== false, onchange() { v.tight = this.checked; redraw(); } });
  const canvas = el("canvas", { width: W, height: H, className: "preview" });
  const state = { v, music: { set() {} }, mp4: null, uploaded: null };
  cards.push(state);
  const redraw = () => {
    const k = pauses(env, words, v.start, v.end);
    gaps.textContent = !k.saved ? " (none found)" : ` (${k.cut ? `${k.cut} pause${k.cut === 1 ? "" : "s"}` : "the quiet at the ends"}: ${Math.round(v.end - v.start - k.saved)} s instead of ${Math.round(v.end - v.start)} s)`;
    return still(canvas, v).catch(() => {});
  };
  const side = sidePanel(canvas);
  const card = el("div", { className: "card" },
    el("div", { className: "vhead" }, el("span", { className: "badge gold", textContent: `Clip ${n + 1}` }), head, span),
    el("div", { className: "video" },
      el("div", {}, quote,
        el("div", { className: "grp", textContent: "The cut" }),
        el("div", { className: "times" }, num("start", "Start (s)"), num("end", "End (s)")),
        el("label", { className: "f" }, "Layout", layout),
        captionPick(v, () => redraw()),
        el("div", { style: "margin-top:12px" }, el("label", { className: "ch" }, tight, "Cut the pauses", gaps)),
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
