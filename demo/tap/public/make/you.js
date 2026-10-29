// Put yourself in it: a phone video of the creator talking about the page, cut out of its background in the
// browser (MediaPipe's selfie segmenter) and laid over the page, which scrolls to what they're saying, with
// their words as captions. The video stays on the device; only its sound goes out, for the words. The page
// is photographed once by Cloudflare's browser (/api/shot) and the scroll is planned from the words (/api/scroll).
import { $, el, call, cards, allBox, sidePanel, pickCodec, encodeAudio, caption, currentPage, W, H, FPS } from "./app.js";
import { open, decode, decoderFor, listen, put, sound, lines } from "./clips.js";
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/build/mp4-muxer.mjs";

const MAX_SECONDS = 90, VIEW = 844; // the phone window the page was photographed through, in CSS px
const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0";
const MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const WORK = 512; // the frame is shrunk to this on its long side for the cutout; the model looks at 256 anyway
const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

const say = (msg, bad) => { $("youStatus").textContent = msg; $("youStatus").className = "status small" + (bad ? " bad" : ""); };
const upright = s => s.rot % 180 ? [s.height, s.width] : [s.width, s.height];
let src = null;

// ---- The page -----------------------------------------------------------------------

$("youFile").onchange = async () => {
  const f = $("youFile").files[0]; src = null; $("youBtn").disabled = true; $("youInfo").textContent = "";
  $("youName").textContent = f ? f.name : "or drop it here";
  if (!f) return;
  say("Reading the video…");
  try {
    if (!("VideoDecoder" in window)) throw new Error("This browser can't cut video. Use Chrome or Edge.");
    src = await open(f);
    await decoderFor(src.video, "video").catch(e => { src = null; throw e; });
    if (!src.audio) { src = null; throw new Error("That video has no sound. Say what the page does, out loud."); }
    const [w, h] = upright(src);
    $("youInfo").textContent = `${Math.round(src.duration)} s · ${w}×${h}${src.duration > MAX_SECONDS ? ` · the first ${MAX_SECONDS} s are used` : ""}`;
    $("youBtn").disabled = false; say("");
  } catch (err) { say(err.message, true); }
};

const drop = $("youDrop");
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = e => {
  e.preventDefault(); drop.classList.remove("over");
  if (!e.dataTransfer.files.length || $("youFile").disabled) return;
  $("youFile").files = e.dataTransfer.files; $("youFile").dispatchEvent(new Event("change"));
};

$("youBtn").onclick = async () => {
  const page = currentPage();
  if (!page?.url) return say("Read a page first.", true);
  $("youBtn").disabled = true; $("youFile").disabled = true;
  try {
    const end = Math.min(src.duration, MAX_SECONDS);
    say("Photographing the page and listening to you…");
    const [heard, shot] = await Promise.all([listen(src, msg => say(msg), end), call("/api/shot", { url: page.url })]);
    if (!heard.segments.length) throw new Error("Nothing was heard in your video. Say what the page does, out loud.");
    say("Planning the scroll…");
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("The page's picture couldn't be read.")); i.src = shot.jpeg; });
    const height = Math.round(img.naturalHeight * shot.width / img.naturalWidth); // CSS px
    // Without the planner (over the cap, say), the page scrolls evenly, at a reading pace.
    const plan = await call("/api/scroll", { segments: heard.segments, elements: shot.elements, height, page: { title: page.title, host: page.host }, duration: end })
      .catch(e => ({ note: e.message, keyframes: [{ t: 0, y: 0 }, { t: end, y: Math.min(Math.max(0, height - VIEW), 70 * end) }], title: page.title || "", caption: "", hashtags: [] }));
    const v = { angle: "You, over the page", title: plan.title || page.title || "", caption: plan.caption, hashtags: plan.hashtags, scenes: [], page,
      end, layout: "cutout", captions: true, keyframes: plan.keyframes, words: heard.words, shot: { img, height } };
    cards.length = 0; $("videos").replaceChildren(); $("allTicks").replaceChildren(); $("allOut").replaceChildren();
    const made = youCard(v, src, plan.note);
    $("videos").replaceChildren(made.card); allBox(); say("");
    made.card.scrollIntoView({ behavior: "smooth", block: "start" });
    await made.still();
  } catch (err) { say(err.message, true); }
  $("youBtn").disabled = false; $("youFile").disabled = false;
};

function youCard(v, s, note) {
  const head = el("h3", { textContent: v.title });
  const title = el("input", { type: "text", value: v.title, maxLength: 100, oninput() { v.title = this.value; head.textContent = this.value; } });
  const cap = el("textarea", { value: v.caption, rows: 3, oninput() { v.caption = this.value; } });
  const hashtags = el("input", { type: "text", value: (v.hashtags || []).map(t => "#" + t).join(" "), oninput() { v.hashtags = this.value.split(/[\s,#]+/).filter(Boolean); } });
  const layout = el("select", { onchange() { v.layout = this.value; redraw(); } },
    el("option", { value: "cutout", textContent: "Cutout: you, over the page" }),
    el("option", { value: "bubble", textContent: "Bubble: you in a circle, bottom left" }),
    el("option", { value: "split", textContent: "Split: the page above, you below" }));
  const caps = el("input", { type: "checkbox", checked: true, onchange() { v.captions = this.checked; redraw(); } });
  const stops = v.keyframes.length - 1;
  const canvas = el("canvas", { width: W, height: H, className: "preview" });
  const state = { v, music: { set() {} }, mp4: null, uploaded: null };
  cards.push(state);
  const redraw = () => still(canvas, v, s).catch(e => say(e.message, true));
  const side = sidePanel(canvas);
  const card = el("div", { className: "card" },
    el("div", { className: "vhead" }, el("span", { className: "badge gold", textContent: "You" }), head, el("span", { className: "small muted", textContent: `${Math.round(v.end)} s · ${v.page.host}` })),
    el("div", { className: "video" },
      el("div", {}, ...(note ? [el("p", { className: "note bad", textContent: note })] : []),
        el("div", { className: "grp", textContent: "The look" }),
        el("label", { className: "f" }, "Layout", layout),
        el("div", { style: "margin-top:12px" }, el("label", { className: "ch" }, caps, "Captions from your words")),
        el("p", { className: "note", textContent: `The page scrolls to ${stops} place${stops === 1 ? "" : "s"} as you talk about them. Rendering reads your video again and cuts you out frame by frame, so give it a minute or two.` }),
        el("div", { className: "grp", textContent: "Post" }),
        el("label", { className: "f" }, "Title (for YouTube and TikTok)", title),
        el("label", { className: "f" }, "Caption", cap),
        el("label", { className: "f" }, "Hashtags", hashtags)),
      side.box));
  state.render = () => side.render(state, (p, msg) => msg || `Rendering… ${Math.round(p * 100)}%`, progress => make(canvas, v, s, progress), "dailies-you.mp4",
    mp4 => mp4.size > 25 * 1048576 ? "Over 25 MB, so it can't be drafted from here. Use a shorter video." : "");
  side.btn.onclick = () => state.render();
  return { card, still: redraw };
}

// ---- The cutout ------------------------------------------------------------------------

let segmenter = null, segAt = 0; // one segmenter for the page; its clock only goes forward

async function getSegmenter(progress) {
  if (segmenter) return segmenter;
  progress(0, "Loading the cutout model (once, about 10 MB)…");
  const { FilesetResolver, ImageSegmenter } = await import(`${VISION}/vision_bundle.mjs`);
  const vision = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const make = delegate => ImageSegmenter.createFromOptions(vision, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", outputConfidenceMasks: true, outputCategoryMask: false });
  // The graphics card when it's quick, else the processor: on some machines the GPU path is slow to read back.
  let seg = await make("GPU").catch(() => null);
  if (seg) {
    const probe = new OffscreenCanvas(288, 512);
    const trial = () => { const t = performance.now(), r = seg.segmentForVideo(probe, segAt += 2); r.confidenceMasks[0].getAsFloat32Array(); r.close(); return performance.now() - t; };
    trial(); if (trial() > 80) { seg.close(); seg = null; }
  }
  segmenter = seg || await make("CPU");
  return segmenter;
}

// Cuts the person out of each upright frame: a soft mask from the model, run again on a crop around them when
// they're small in the frame, steadied with the last mask, and applied with a blurred edge. Keeps the box around them.
function cutter(seg, uw, uh) {
  const k = WORK / Math.max(uw, uh), ww = Math.max(16, Math.round(uw * k)), wh = Math.max(16, Math.round(uh * k));
  const work = new OffscreenCanvas(ww, wh), wctx = work.getContext("2d", { willReadFrequently: true });
  const maskC = new OffscreenCanvas(ww, wh), mctx = maskC.getContext("2d");
  const person = new OffscreenCanvas(uw, uh), pctx = person.getContext("2d");
  let img = null, last = null, box = null, lastAt = -1;
  const confidence = (source, at) => {
    const r = seg.segmentForVideo(source, at), m = r.confidenceMasks[r.confidenceMasks.length - 1], out = { f: m.getAsFloat32Array().slice(), w: m.width, h: m.height };
    r.close(); return out;
  };
  const extent = (m, w, h, over) => {
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let i = 0; i < m.length; i++) if (m[i] > over) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : [x0, y0, x1, y1];
  };
  // The frame through the mask: everything but the person goes clear.
  const apply = (f, rot) => {
    pctx.globalCompositeOperation = "source-over"; pctx.filter = "none"; pctx.clearRect(0, 0, uw, uh); put(pctx, f, 0, 0, uw, uh, rot);
    pctx.globalCompositeOperation = "destination-in"; pctx.filter = `blur(${Math.max(1, uh / 240).toFixed(1)}px)`; pctx.drawImage(maskC, 0, 0, uw, uh);
    pctx.filter = "none"; pctx.globalCompositeOperation = "source-over";
  };
  return {
    person, box: () => box,
    // A talking creator barely moves, so the mask is found at most 20 times a second and the frames between reuse it.
    cut(f, rot, ts) {
      if (box && ts - lastAt < 0.045) { apply(f, rot); return true; }
      lastAt = ts;
      put(wctx, f, 0, 0, ww, wh, rot);
      let { f: m, w, h } = confidence(work, segAt += 2);
      const first = extent(m, w, h, 0.5);
      if (!first) { box = null; last = null; return false; }
      const [x0, y0, x1, y1] = first;
      if (y1 - y0 < h * 0.7) {
        const px = (x1 - x0) * 0.25 + 8, py = (y1 - y0) * 0.25 + 8;
        const cx = Math.max(0, Math.floor(x0 - px)), cy = Math.max(0, Math.floor(y0 - py));
        const cw = Math.min(w - cx, Math.ceil(x1 - x0 + 2 * px)), ch = Math.min(h - cy, Math.ceil(y1 - y0 + 2 * py));
        const crop = new OffscreenCanvas(cw, ch); crop.getContext("2d").drawImage(work, cx * ww / w, cy * wh / h, cw * ww / w, ch * wh / h, 0, 0, cw, ch);
        const c = confidence(crop, segAt += 1);
        m = new Float32Array(w * h);
        for (let yy = 0; yy < Math.min(ch, c.h); yy++) for (let xx = 0; xx < Math.min(cw, c.w); xx++) m[(cy + yy) * w + cx + xx] = c.f[yy * c.w + xx];
      }
      if (last && last.length === m.length) for (let i = 0; i < m.length; i++) m[i] = m[i] * 0.7 + last[i] * 0.3;
      last = m;
      // Sure background under .4, sure person over .6, a ramp between; the alpha is all that's used.
      if (!img || img.width !== w || img.height !== h) { img = new ImageData(w, h); maskC.width = w; maskC.height = h; }
      const d = img.data;
      for (let i = 0; i < m.length; i++) d[i * 4 + 3] = Math.min(1, Math.max(0, (m[i] - 0.4) / 0.2)) * 255;
      const seen = extent(m, w, h, 0.5);
      if (!seen) { box = null; return false; }
      mctx.putImageData(img, 0, 0);
      apply(f, rot);
      const sx = uw / w, sy = uh / h, pad = uh * 0.02;
      box = { x: Math.max(0, seen[0] * sx - pad), y: Math.max(0, seen[1] * sy - pad), r: Math.min(uw, (seen[2] + 1) * sx + pad), b: Math.min(uh, (seen[3] + 1) * sy + pad) };
      return true;
    },
  };
}

async function cutterFor(s, progress) {
  const seg = await getSegmenter(progress).catch(e => { throw new Error(`The cutout can't run in this browser (${e.message}). Try Chrome, or the Bubble or Split layout.`); });
  return cutter(seg, ...upright(s));
}

// ---- Drawing a frame --------------------------------------------------------------------

// The page's scroll (CSS px) at t: it holds at a keyframe, then glides to the next, faster for longer moves.
function scrollAt(kf, t) {
  const i = kf.findLastIndex(k => k.t <= t);
  if (i < 0) return kf[0]?.y || 0;
  const a = kf[i], b = kf[i + 1];
  if (!b) return a.y;
  const glide = Math.min((b.t - a.t) * 0.8, Math.max(0.6, Math.abs(b.y - a.y) / 1200)), from = b.t - glide;
  if (t <= from) return a.y;
  const u = (t - from) / glide, e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
  return a.y + (b.y - a.y) * e;
}

// Where the person goes in Cutout: their box, eased from frame to frame so they don't jump; bottom centre, up to 55% of the height.
function place(box, smooth) {
  if (smooth.r === undefined) Object.assign(smooth, box); else for (const k of "xyrb") smooth[k] += (box[k] - smooth[k]) * 0.2;
  const bw = smooth.r - smooth.x, bh = smooth.b - smooth.y, s = Math.min(H * 0.55 / bh, W * 0.92 / bw);
  return { sx: smooth.x, sy: smooth.y, sw: bw, sh: bh, dx: (W - bw * s) / 2, dy: H - bh * s, dw: bw * s, dh: bh * s };
}

function pill(ctx, text) {
  ctx.font = `600 34px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const w = Math.min(W - 80, ctx.measureText(text).width + 90), x = (W - w) / 2, y = 56, h = 72;
  ctx.fillStyle = "rgba(20,20,20,0.72)"; ctx.beginPath(); ctx.roundRect(x, y, w, h, 36); ctx.fill();
  ctx.fillStyle = "#e8b830"; ctx.beginPath(); ctx.arc(x + 36, y + h / 2, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.fillText(text, x + w / 2 + 14, y + h / 2 + 1, w - 90);
}

function drawFrame(ctx, v, s, f, cut, has, t, smooth) {
  const { img, height } = v.shot, scale = W / img.naturalWidth, ph = img.naturalHeight * scale;
  const y = scrollAt(v.keyframes, t) / height * ph, [uw, uh] = upright(s);
  ctx.fillStyle = "#0b0b0b"; ctx.fillRect(0, 0, W, H);
  if (v.layout === "split") {
    const top = Math.round(H * 0.6);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, top); ctx.clip(); ctx.drawImage(img, 0, -Math.min(y, Math.max(0, ph - top)), W, ph); ctx.restore();
    const k = Math.max(W / uw, (H - top) / uh);
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, W, H - top); ctx.clip(); put(ctx, f, (W - uw * k) / 2, top + (H - top - uh * k) / 2, uw * k, uh * k, s.rot); ctx.restore();
  } else {
    ctx.drawImage(img, 0, -Math.min(y, Math.max(0, ph - H)), W, ph);
    if (v.layout === "cutout" && has) {
      const p = place(cut.box(), smooth);
      ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12;
      ctx.drawImage(cut.person, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    } else {
      // The whole picture in a gold-ringed circle, bottom left, framed on the upper part where a face is.
      const r = W * 0.19, cx = 44 + r, cy = H - 64 - r, k = Math.max(2 * r / uw, 2 * r / uh);
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 30; ctx.fillStyle = "#000"; ctx.fill();
      ctx.shadowColor = "transparent"; ctx.clip();
      put(ctx, f, cx - uw * k / 2, cy - uh * k * (uh > uw ? 0.38 : 0.5), uw * k, uh * k, s.rot); ctx.restore();
      ctx.lineWidth = 10; ctx.strokeStyle = "#e8b830"; ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.stroke();
    }
  }
  pill(ctx, v.page.host || "");
  if (v.captions) {
    const c = v.lines.findLast(c => c.s <= t);
    if (c && t < c.e + 0.6) caption(ctx, c.text, t - c.s, v.layout === "cutout" ? H * 0.36 : H * 0.66);
  }
}

// ---- Rendering --------------------------------------------------------------------------

async function still(canvas, v, s) {
  const at = Math.min(1, v.end / 2);
  let best = null;
  await decode(s.video, "video", at, at, f => { if (f.timestamp / 1e6 <= at || !best) { best?.close(); best = f; } else f.close(); });
  if (!best) return;
  try {
    v.lines = lines({ start: 0, end: v.end }, v.words);
    let cut = null, has = false;
    if (v.layout === "cutout") { cut = await cutterFor(s, (p, msg) => say(msg)); has = cut.cut(best, s.rot, at); say(""); }
    drawFrame(canvas.getContext("2d"), v, s, best, cut, has, at, {});
  } finally { best.close(); }
}

async function make(canvas, v, s, progress) {
  const { config, mux } = await pickCodec();
  const ctx = canvas.getContext("2d"), frames = Math.round(v.end * FPS), smooth = {};
  v.lines = lines({ start: 0, end: v.end }, v.words);
  const cut = v.layout === "cutout" ? await cutterFor(s, progress) : null;
  progress(0, "Cutting the sound…");
  const snd = await sound(s, 0, v.end);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: mux, width: W, height: H, frameRate: FPS },
    ...(snd && { audio: { codec: snd.mux, sampleRate: 48000, numberOfChannels: 2 } }), fastStart: "in-memory" });
  let failed = null, k = 0, prev = null, has = false;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => failed = e });
  enc.configure(config);
  const emit = () => {
    drawFrame(ctx, v, s, prev, cut, has, k / FPS, smooth);
    const out = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(out, { keyFrame: k % (FPS * 2) === 0 }); out.close(); k++;
  };
  const take = f => { prev?.close(); prev = f; if (cut) has = cut.cut(f, s.rot, f.timestamp / 1e6); };
  // Each source frame is cut out once; each output frame (30 a second) shows the latest source frame at or before its time.
  await decode(s.video, "video", 0, v.end, f => {
    const ts = f.timestamp / 1e6;
    if (!prev) take(f);
    while (k < frames && k / FPS < ts) emit();
    if (prev !== f) take(f);
  }, async () => {
    if (failed) throw failed;
    while (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
    progress(k / frames);
  });
  while (prev && k < frames) emit();
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
