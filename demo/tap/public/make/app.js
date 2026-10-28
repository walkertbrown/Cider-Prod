// Link to Shorts, the browser half: read → scripts → render (canvas, WebCodecs, MP4) → upload → draft.
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/build/mp4-muxer.mjs";

const W = 1080, H = 1920, FPS = 30, END = 2.5;
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
// Each video can carry its own page (a store product); otherwise it uses the page that was read.
const pg = v => v.page || page;
const img = u => u.startsWith(location.origin + "/i/") ? u : `/api/img?u=${encodeURIComponent(u)}`;

call.raw = async (path, body) => {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Dailies answered ${r.status}.`);
  return r.arrayBuffer();
};

async function call(path, body, method = "POST") {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({ error: `Dailies answered ${r.status}.` }));
  if (r.status === 401) location.href = "/auth/start";
  if (!r.ok || d.error) throw new Error(d.error || `Dailies answered ${r.status}.`);
  return d;
}

let page = null, channels = null;

$("readForm").onsubmit = async e => {
  e.preventDefault(); $("storeBox").hidden = true; $("planBox").hidden = true; $("planList").replaceChildren(); $("planActs").hidden = true; $("planStatus").textContent = "";
  $("readBtn").disabled = true; $("readStatus").textContent = "Reading…"; $("readStatus").className = "status small"; $("pageBox").hidden = true;
  try {
    page = await call("/api/read", { urls: $("url").value.split(/\s+/).filter(Boolean) });
    $("pTitle").textContent = page.title || page.host;
    $("pHost").textContent = page.host;
    $("pPages").replaceChildren(...(page.pages.length > 1 ? page.pages.map(p => el("li", { textContent: p.title || p.url })) : []),
      ...page.failed.map(f => el("li", { className: "bad", textContent: f })));
    $("pImgs").replaceChildren(...page.images.map(u => el("img", { src: img(u), alt: "", loading: "lazy", onerror() { this.remove(); } })));
    $("count").replaceChildren(...Array.from({ length: 10 }, (_, i) => el("option", { value: i + 1, textContent: i + 1, selected: i + 1 === page.suggested })));
    $("pWhy").textContent = `Suggested: ${page.suggested}. ${page.pages.length > 1 ? `The ${page.pages.length} pages have` : "The page has"} ${page.why}. More than that gets you different angles on the same material.`;
    $("pageBox").hidden = false; $("readStatus").textContent = "";
    showStore(page.store);
    showPlan();
  } catch (err) { $("readStatus").textContent = err.message; $("readStatus").className = "status small bad"; }
  $("readBtn").disabled = false;
};

$("writeBtn").onclick = async () => {
  $("writeBtn").disabled = true; $("writeStatus").textContent = "Writing scripts… (about 10–30 seconds)"; $("writeStatus").className = "status small";
  try {
    const out = await call("/api/scripts", { page, count: +$("count").value });
    $("writeStatus").textContent = out.note && out.videos.length < +$("count").value ? out.note : "";
    cards.length = 0;
    $("videos").replaceChildren(...out.videos.map(videoCard));
    $("allTicks").replaceChildren(); $("allOut").replaceChildren(); allBox();
  } catch (err) { $("writeStatus").textContent = err.message; $("writeStatus").className = "status small bad"; }
  $("writeBtn").disabled = false;
};

// ---- Store mode: a Shopify store's products, one video each ----------------

const money = (store, p) => p.price ? `${p.price}${store.currency ? " " + store.currency : ""}` : "";
function showStore(store) {
  $("storeBox").hidden = !store;
  if (!store) return;
  $("sTitle").textContent = `${store.name}: a Shopify store${store.collection ? ` (collection “${store.collection}”)` : ""} with ${store.products.length}${store.products.length === 50 ? "+" : ""} products`;
  $("sList").replaceChildren(...store.products.map((p, i) => el("label", { className: "prod" },
    el("input", { type: "checkbox", value: i, checked: i < 5, onchange: storeCount }),
    p.images[0] ? el("img", { src: img(p.images[0]), alt: "", loading: "lazy" }) : el("span"),
    el("span", {}, p.title, el("span", { className: "small muted", textContent: [money(store, p), p.type].filter(Boolean).map(x => " · " + x).join("") })))));
  storeCount();
}
function storeCount() {
  const n = $("sList").querySelectorAll("input:checked").length;
  $("storeBtn").textContent = `Write ${n} video${n === 1 ? "" : "s"}, one per product`;
  $("storeBtn").disabled = !n || n > 10;
  $("sNote").textContent = n > 10 ? "Up to 10 at a time." : "Each product gets its own video, from its own pictures and description, ending on its own page. Each one counts as a script run.";
}
$("storeBtn").onclick = async () => {
  const store = page.store, picked = [...$("sList").querySelectorAll("input:checked")].map(c => store.products[+c.value]);
  $("storeBtn").disabled = true; $("storeStatus").className = "status small";
  cards.length = 0; $("videos").replaceChildren(); $("allTicks").replaceChildren(); $("allOut").replaceChildren();
  const failed = [];
  for (const [i, p] of picked.entries()) {
    $("storeStatus").textContent = `Writing ${i + 1} of ${picked.length}: ${p.title}…`;
    const one = { url: p.url, host: new URL(p.url).hostname, title: p.title, description: [money(store, p), p.was && +p.was > +p.price ? `was ${p.was}` : "", p.type].filter(Boolean).join(" · "),
      text: `Store: ${store.name}\nProduct: ${p.title}\nPrice: ${money(store, p)}${p.was && +p.was > +p.price ? ` (was ${p.was})` : ""}\nType: ${p.type}\nBy: ${p.vendor}\n\n${p.text}`,
      images: p.images, products: [], pages: [] };
    try {
      const out = await call("/api/scripts", { page: one, count: 1 });
      for (const v of out.videos) { v.page = one; $("videos").append(videoCard(v, cards.length)); }
      allBox();
    } catch (err) { failed.push(`${p.title}: ${err.message}`); if (/cap|limit|today/i.test(err.message)) break; }
  }
  $("storeStatus").textContent = failed.join(" ");
  $("storeStatus").className = failed.length ? "status small bad" : "status small";
  storeCount();
};

// ---- The planner: a month of dated items; write any video from it, or save it as Buffer Ideas ----

let plan = [];
const NET = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", twitter: "X", bluesky: "Bluesky", threads: "Threads", linkedin: "LinkedIn", facebook: "Facebook", mastodon: "Mastodon" };
function showPlan() {
  $("planBox").hidden = false;
  if (!$("start").value) $("start").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
}
$("planBtn").onclick = async () => {
  $("planBtn").disabled = true; $("planStatus").className = "status small"; $("planStatus").textContent = "Laying out the plan… (about 10–30 seconds)";
  $("ideasOut").replaceChildren();
  try {
    ({ items: plan } = await call("/api/plan", { page, start: $("start").value, weeks: +$("weeks").value, perWeek: +$("perWeek").value }));
    $("planStatus").textContent = `${plan.length} posts.`;
    const day = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    $("planList").replaceChildren(el("table", { className: "plan" }, ...plan.map(it => {
      const act = it.kind === "video" ? el("button", { textContent: "Write this video", async onclick() {
        this.disabled = true; this.textContent = "Writing…";
        try {
          const out = await call("/api/scripts", { page: it.page || page, count: 1, angle: it });
          for (const v of out.videos) { v.angle = v.angle || it.angle; $("videos").append(videoCard(v, cards.length)); }
          allBox(); this.textContent = "Written below";
        } catch (err) { this.textContent = "Write this video"; this.disabled = false; $("planStatus").textContent = err.message; $("planStatus").className = "status small bad"; }
      } }) : "";
      return el("tr", {},
        el("td", {}, el("input", { type: "checkbox", checked: true, onchange() { it.skip = !this.checked; } })),
        el("td", { className: "d", textContent: day(it.date) }),
        el("td", {}, el("strong", { textContent: it.angle }), el("div", { textContent: it.hook }),
          el("div", { className: "small muted", textContent: `${it.kind === "video" ? "Video" : "Text"} · ${it.services.map(s => NET[s] || s).join(", ")}${it.text ? " · " + it.text : ""}` })),
        el("td", {}, act));
    })));
    $("planActs").hidden = !plan.length;
  } catch (err) { $("planStatus").textContent = err.message; $("planStatus").className = "status small bad"; }
  $("planBtn").disabled = false;
};
$("ideasBtn").onclick = async () => {
  const items = plan.filter(it => !it.skip);
  $("ideasBtn").disabled = true; $("ideasOut").className = "status small"; $("ideasOut").textContent = `Saving ${items.length} ideas…`;
  try {
    const { results } = await call("/api/ideas", { items });
    const bad = results.filter(r => !r.ok);
    $("ideasOut").textContent = `${results.length - bad.length} of ${results.length} saved as Ideas in Buffer.` + bad.map(r => ` ${r.date}: ${r.error}`).join("");
    if (bad.length) $("ideasOut").className = "status small bad";
  } catch (err) { $("ideasOut").textContent = err.message; $("ideasOut").className = "status small bad"; }
  $("ideasBtn").disabled = false;
};

// ---- One video's card: editable script, render, preview, draft --------------

function videoCard(v, n) {
  const scenes = el("div");
  const sceneRow = s => {
    const thumb = s.image == null ? el("div", { className: "noimg" }) : el("img", { src: img(pg(v).images[s.image]), alt: "" });
    const text = el("textarea", { value: s.text, rows: 2, oninput() { s.text = this.value; } });
    const pick = el("select", { title: "Image", onchange() { s.image = this.value === "" ? null : +this.value;
      const t = s.image == null ? el("div", { className: "noimg" }) : el("img", { src: img(pg(v).images[s.image]), alt: "" }); row.firstChild.replaceWith(t); } },
      el("option", { value: "", textContent: "none" }), ...pg(v).images.map((_, i) => el("option", { value: i, textContent: `image ${i + 1}`, selected: s.image === i })));
    const row = el("div", { className: "scene" }, thumb, text, pick);
    return row;
  };
  scenes.append(...v.scenes.map(sceneRow));
  const title = el("input", { type: "text", value: v.title, maxLength: 100, oninput() { v.title = this.value; } });
  const caption = el("textarea", { value: v.caption, rows: 3, oninput() { v.caption = this.value; } });
  const hashtags = el("input", { type: "text", value: (v.hashtags || []).map(t => "#" + t).join(" "), oninput() { v.hashtags = this.value.split(/[\s,#]+/).filter(Boolean); } });
  const canvas = el("canvas", { width: W, height: H, className: "preview" });
  const status = el("p", { className: "status small" });
  const renderBtn = el("button", { className: "primary", textContent: "Render" });
  const draftBox = el("div", { hidden: true });
  const music = musicControls(v);
  const voice = el("select", { style: "width:auto", onchange() { v.voice = this.value; } },
    el("option", { value: "", textContent: "No voiceover" }),
    ...[["coral", "Coral (warm)"], ["nova", "Nova (bright)"], ["sage", "Sage (calm)"], ["ash", "Ash (low)"], ["onyx", "Onyx (deep)"], ["verse", "Verse (lively)"]]
      .map(([value, textContent]) => el("option", { value, textContent })));
  const state = { v, music, mp4: null, uploaded: null };
  cards.push(state);
  const side = el("div", {}, canvas, status, el("div", { className: "row" }, renderBtn), draftBox);
  const card = el("div", { className: "card" },
    el("div", { className: "small muted", textContent: `Video ${n + 1}: ${v.angle}` }),
    el("div", { className: "video" },
      el("div", {}, scenes, el("label", { className: "small muted", textContent: "Title (YouTube, TikTok)" }), title,
        el("label", { className: "small muted", textContent: "Caption" }), caption,
        el("label", { className: "small muted", textContent: "Hashtags (each network gets as many as suit it)" }), hashtags,
        el("label", { className: "small muted", style: "display:block;margin-top:10px", textContent: "Voiceover (reads each line aloud; scenes stretch to fit)" }), voice, music.box),
      side));
  drawStill(canvas, v);

  state.render = async () => {
    renderBtn.disabled = true; status.className = "status small";
    try {
      state.mp4 = null; state.uploaded = null;
      side.querySelector("video")?.remove(); canvas.hidden = false; draftBox.replaceChildren(); draftBox.hidden = true;
      const mp4 = await render(canvas, v, (p, msg) => status.textContent = msg || `Rendering… ${Math.round(p * 100)}%`);
      const video = el("video", { src: URL.createObjectURL(mp4), controls: true, playsInline: true });
      canvas.hidden = true; canvas.after(video);
      const notes = [mp4.vp9 && "VP9 (this browser can't make H.264; some networks may refuse it, and Chrome makes H.264)", mp4.opus && "music as Opus (this browser can't make AAC; some networks may refuse it)"].filter(Boolean);
      status.textContent = `${(mp4.size / 1048576).toFixed(1)} MB${notes.length ? ", " + notes.join(", ") : ""}. `;
      status.append(el("a", { href: video.src, download: `tap-video-${n + 1}.mp4`, textContent: "Download" }));
      state.mp4 = mp4;
      await showDraft(draftBox, state);
      renderBtn.textContent = "Render again";
    } catch (err) { status.textContent = err.message; status.className = "status small bad"; }
    renderBtn.disabled = false;
    allBox();
  };
  renderBtn.onclick = () => state.render();
  return card;
}

// ---- Music: a file from the visitor's device, mixed in at render time --------

const cards = [];
const audioCtx = () => (audioCtx.c ??= new AudioContext());

function musicControls(v) {
  const file = el("input", { type: "file", accept: "audio/*,.mp3,.m4a,.wav,.aac,.ogg" });
  const name = el("span", { className: "small muted" });
  const start = el("input", { type: "number", min: 0, step: 1, value: 0, style: "width:5em", title: "Start the song this many seconds in" });
  const vol = el("input", { type: "range", min: 5, max: 100, value: 80, title: "Volume" });
  const clear = el("button", { type: "button", textContent: "Remove", hidden: true });
  const all = el("button", { type: "button", textContent: "Use on every video", hidden: true });
  const opts = el("div", { className: "row small", hidden: true }, el("label", {}, "Start at ", start, " s"), el("label", {}, "Volume ", vol), all, clear);
  const set = (m, label) => {
    v.music = m; name.textContent = label || ""; opts.hidden = !m; clear.hidden = !m; all.hidden = !m || cards.length < 2;
    if (m) { start.value = m.start; vol.value = Math.round(m.volume * 100); } else file.value = "";
  };
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    name.textContent = "Reading the song…";
    try {
      if (f.size > 60 * 1048576) throw new Error("Pick a song file under 60 MB.");
      const buffer = await audioCtx().decodeAudioData(await f.arrayBuffer());
      set({ buffer, start: 0, volume: 0.8, name: f.name }, `${f.name} (${Math.round(buffer.duration)} s)`);
    } catch (e) { set(null, e.message?.includes("60 MB") ? e.message : "That file couldn't be read as audio. Try an MP3, M4A or WAV."); }
  };
  start.oninput = () => v.music && (v.music.start = Math.max(0, +start.value || 0));
  vol.oninput = () => v.music && (v.music.volume = +vol.value / 100);
  clear.onclick = () => set(null);
  all.onclick = () => cards.forEach(c => c.v !== v && c.music.set({ ...v.music }, `${v.music.name} (${Math.round(v.music.buffer.duration)} s)`));
  const box = el("div", { style: "margin-top:10px" },
    el("label", { className: "small muted", textContent: "Music (optional, a file from your device)" }), el("div", { className: "row" }, file, name), opts,
    el("p", { className: "small muted", style: "margin:4px 0 0", textContent: "Use music you have the rights to. Networks can mute or block songs they recognise." }));
  return { box, set };
}

// Each scene's line read aloud, fetched once per (voice, text).
const spoken = new Map();
function speak(voice, text) {
  const k = voice + "\n" + text;
  if (!spoken.has(k)) spoken.set(k, call.raw("/api/voice", { voice, text }).then(b => audioCtx().decodeAudioData(b)).catch(e => { spoken.delete(k); throw e; }));
  return spoken.get(k);
}

// The voice lines placed at their scenes, and the song from its start point under them
// (lower while there's a voice), cut to the video's length, faded in and out, 48 kHz stereo.
async function mixAudio(m, seconds, lines = []) {
  const rate = 48000, ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  if (m) {
    const vol = m.volume * (lines.length ? 0.3 : 1);
    const src = ctx.createBufferSource(); src.buffer = m.buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(vol, 0.3);
    g.gain.setValueAtTime(vol, Math.max(0.3, seconds - 1.5)); g.gain.linearRampToValueAtTime(0, seconds);
    src.connect(g).connect(ctx.destination);
    src.start(0, Math.min(m.start, Math.max(0, m.buffer.duration - 1)));
  }
  for (const { buffer, at } of lines) {
    const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(ctx.destination); src.start(at);
  }
  return ctx.startRendering();
}

async function pickAudioCodec() {
  if (!("AudioEncoder" in window)) throw new Error("This browser can't encode audio. Use Chrome or Edge, or remove the music.");
  for (const [codec, mux] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
    const config = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 160_000 };
    if ((await AudioEncoder.isConfigSupported(config).catch(() => ({}))).supported) return { config, mux };
  }
  throw new Error("This browser can't encode audio. Use Chrome or Edge, or remove the music.");
}

async function encodeAudio(muxer, audio, config) {
  let failed = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => failed = e });
  enc.configure(config);
  const step = 4800, chans = [audio.getChannelData(0), audio.getChannelData(1)];
  for (let i = 0; i < audio.length; i += step) {
    const n = Math.min(step, audio.length - i), data = new Float32Array(n * 2);
    data.set(chans[0].subarray(i, i + n), 0); data.set(chans[1].subarray(i, i + n), n);
    const a = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i * 1e6 / 48000), data });
    enc.encode(a); a.close();
    if (failed) throw failed;
  }
  await enc.flush();
  if (failed) throw failed;
}

async function upload(state) {
  if (state.uploaded) return state.uploaded;
  const r = await fetch("/api/upload", { method: "PUT", headers: { "content-type": "video/mp4" }, body: state.mp4 });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Upload failed (${r.status}).`);
  return state.uploaded = d.id;
}

async function draft(state, chosen) {
  const id = await upload(state);
  const { results } = await call("/api/draft", { video: id, channels: chosen, caption: state.v.caption, title: state.v.title, hashtags: state.v.hashtags, angle: state.v.angle });
  return results;
}

async function showDraft(box, state) {
  channels ??= (await call("/api/channels", null, "GET")).channels;
  if (!channels.length) { box.append(el("p", { className: "small muted", textContent: "No Buffer channels that take video are connected." })); box.hidden = false; return; }
  const ticks = channels.map(c => el("input", { type: "checkbox", value: c.id, checked: ["instagram", "tiktok", "youtube"].includes(c.service) }));
  const btn = el("button", { className: "primary", textContent: "Draft to Buffer" });
  const out = el("p", { className: "status small" });
  box.append(el("p", { className: "small", style: "margin:10px 0 4px", textContent: "Draft it to:" }),
    ...channels.map((c, i) => el("label", { className: "ch" }, ticks[i], c.service)), el("div", { className: "row" }, btn), out);
  box.hidden = false;
  btn.onclick = async () => {
    const chosen = ticks.filter(t => t.checked).map(t => t.value);
    if (!chosen.length) { out.textContent = "Pick at least one channel."; return; }
    btn.disabled = true; out.className = "status small"; out.textContent = "Uploading and drafting…";
    try {
      const results = await draft(state, chosen);
      out.replaceChildren(...results.map(r => el("div", { className: r.ok ? "" : "bad", textContent: r.ok ? `${r.channel}: in your Buffer drafts` : `${r.channel}: ${r.error}` })));
      if (results.some(r => !r.ok)) btn.disabled = false;
    } catch (err) { out.textContent = err.message; out.className = "status small bad"; btn.disabled = false; }
  };
}

// ---- All videos at once ------------------------------------------------------

async function allBox() {
  const box = $("allBox");
  if (cards.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  const made = cards.filter(c => c.mp4).length;
  $("allMade").textContent = `${made} of ${cards.length} rendered.`;
  $("draftAll").disabled = !made;
  if (made && !$("allTicks").children.length) {
    channels ??= (await call("/api/channels", null, "GET")).channels;
    $("allTicks").replaceChildren(...channels.map(c => el("label", { className: "ch" },
      el("input", { type: "checkbox", value: c.id, checked: ["instagram", "tiktok", "youtube"].includes(c.service) }), c.service)));
  }
}

$("renderAll").onclick = async () => {
  $("renderAll").disabled = true;
  for (const c of cards) if (!c.mp4) await c.render();
  $("renderAll").disabled = false;
};

$("draftAll").onclick = async () => {
  const chosen = [...$("allTicks").querySelectorAll("input:checked")].map(t => t.value);
  const out = $("allOut");
  if (!chosen.length) { out.textContent = "Pick at least one channel."; return; }
  $("draftAll").disabled = true; out.className = "status small"; out.replaceChildren();
  for (const [i, c] of cards.entries()) {
    if (!c.mp4) continue;
    const line = el("div", { textContent: `Video ${i + 1}: uploading and drafting…` }); out.append(line);
    try {
      const results = await draft(c, chosen);
      line.textContent = `Video ${i + 1}: ` + results.map(r => r.ok ? `${r.channel} drafted` : `${r.channel} failed (${r.error})`).join(", ");
      if (results.some(r => !r.ok)) line.className = "bad";
    } catch (err) { line.textContent = `Video ${i + 1}: ${err.message}`; line.className = "bad"; }
  }
  $("draftAll").disabled = false;
};

// ---- Rendering -------------------------------------------------------------

const bitmaps = new Map();
async function bitmap(u) {
  if (!u) return null;
  if (!bitmaps.has(u)) bitmaps.set(u, fetch(img(u)).then(r => r.ok ? r.blob() : null).then(b => b && createImageBitmap(b)).catch(() => null));
  return bitmaps.get(u);
}

// Words grouped into caption chunks of up to 4 words (or ~22 characters).
function chunks(text) {
  const out = []; let cur = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur.length && (cur.length >= 4 || (cur.join(" ") + " " + w).length > 22)) { out.push(cur.join(" ")); cur = []; }
    cur.push(w);
  }
  if (cur.length) out.push(cur.join(" "));
  return out.length ? out : [""];
}

function wrap(ctx, text, max) {
  const lines = []; let line = "";
  for (const w of text.split(" ")) { const t = line ? line + " " + w : w; if (ctx.measureText(t).width > max && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line);
  return lines;
}

function background(ctx, bmp, t, seed) {
  ctx.fillStyle = "#15140f"; ctx.fillRect(0, 0, W, H);
  if (!bmp) {
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#2a261b"); g.addColorStop(1, "#15140f");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); return;
  }
  // Fill the frame (cover), then a slow zoom and drift; direction alternates by scene.
  const z = 1.06 + 0.10 * t, dir = seed % 2 ? 1 : -1;
  const s = Math.max(W / bmp.width, H / bmp.height) * z;
  const w = bmp.width * s, h = bmp.height * s;
  const x = (W - w) / 2 + dir * (t - 0.5) * Math.min(80, (w - W) / 2), y = (H - h) / 2;
  // A blurred copy behind, so a wide image never leaves bars.
  ctx.filter = "blur(40px) brightness(0.6)";
  const sb = Math.max(W / bmp.width, H / bmp.height) * 1.2;
  ctx.drawImage(bmp, (W - bmp.width * sb) / 2, (H - bmp.height * sb) / 2, bmp.width * sb, bmp.height * sb);
  ctx.filter = "none";
  ctx.drawImage(bmp, x, y, w, h);
  const g = ctx.createLinearGradient(0, H * 0.45, 0, H); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.75)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

function caption(ctx, text, appear) {
  ctx.font = "800 104px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const lines = wrap(ctx, text.toUpperCase(), W - 140);
  const lh = 122, y0 = H * 0.66 - (lines.length - 1) * lh / 2;
  const k = Math.min(1, appear * 6), sc = 0.9 + 0.1 * k;
  ctx.save(); ctx.globalAlpha = k; ctx.translate(W / 2, 0); ctx.scale(sc, sc);
  lines.forEach((l, i) => {
    ctx.lineWidth = 14; ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineJoin = "round"; ctx.strokeText(l, 0, (y0 + i * lh) / sc);
    ctx.fillStyle = i === 0 ? "#ffffff" : "#ffd75e"; ctx.fillText(l, 0, (y0 + i * lh) / sc);
  });
  ctx.restore();
}

// The largest font size (from max down) at which text fits in width.
function fit(ctx, text, weight, max, width) {
  let size = max;
  do { ctx.font = `${weight} ${size}px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`; size -= 4; } while (ctx.measureText(text).width > width && size > 28);
  return size + 4;
}

function endCard(ctx, v, t) {
  ctx.fillStyle = "#15140f"; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.globalAlpha = Math.min(1, t * 4);
  ctx.fillStyle = "#e8b830"; ctx.fillRect(W / 2 - 60, H * 0.40, 120, 10);
  const P = pg(v), path = P.url ? new URL(P.url).pathname.replace(/\/$/, "") : "";
  const where = P.host ? P.host + (path.length > 1 && path.length < 24 ? path : "") : (P.title || "").slice(0, 40);
  const size = fit(ctx, where, 800, 110, W - 120);
  ctx.fillStyle = "#efeadc"; ctx.fillText(where, W / 2, H * 0.48);
  ctx.font = "500 52px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"; ctx.fillStyle = "#a59f8f";
  wrap(ctx, (P.host ? P.title || "" : "").slice(0, 80), W - 200).slice(0, 2).forEach((l, i) => ctx.fillText(l, W / 2, H * 0.48 + size / 2 + 70 + i * 64));
  ctx.globalAlpha = 1;
}

function timeline(v) {
  let at = 0;
  const parts = v.scenes.map((s, i) => { const p = { s, i, from: at, to: at + s.seconds }; at += s.seconds; return p; });
  return { parts, total: at + END };
}

function frame(ctx, v, tl, bmps, t) {
  const p = tl.parts.find(p => t < p.to);
  if (!p) return endCard(ctx, v, (t - (tl.total - END)) / END);
  const local = (t - p.from) / (p.to - p.from);
  background(ctx, bmps[p.i], local, p.i);
  const cs = chunks(p.s.text), ci = Math.min(cs.length - 1, Math.floor(local * cs.length));
  caption(ctx, cs[ci], local * cs.length - ci);
}

async function drawStill(canvas, v) {
  const ctx = canvas.getContext("2d");
  const bmps = await Promise.all(v.scenes.map(s => bitmap(s.image == null ? null : pg(v).images[s.image])));
  frame(ctx, v, timeline(v), bmps, Math.min(1.2, v.scenes[0].seconds * 0.6));
}

async function pickCodec() {
  if (!("VideoEncoder" in window)) throw new Error("This browser can't encode video. Use Chrome, Edge or a recent Safari.");
  // H.264 is what every network takes. VP9 in MP4 is the fallback for browsers without it (some networks may refuse it).
  for (const [codec, mux] of [["avc1.640028", "avc"], ["avc1.4d0028", "avc"], ["avc1.42002a", "avc"], ["vp09.00.40.08", "vp9"]]) {
    const config = { codec, width: W, height: H, bitrate: 3_000_000, framerate: FPS, ...(mux === "avc" && { avc: { format: "avc" } }) };
    if ((await VideoEncoder.isConfigSupported(config).catch(() => ({}))).supported) return { config, mux };
  }
  throw new Error("This browser can't encode video at 1080×1920. Use Chrome or Edge.");
}

async function render(canvas, v, progress) {
  const { config, mux } = await pickCodec();
  const ctx = canvas.getContext("2d");
  const bmps = await Promise.all(v.scenes.map(s => bitmap(s.image == null ? null : pg(v).images[s.image])));
  let voices = [];
  if (v.voice) {
    progress(0, "Recording the voiceover…");
    voices = await Promise.all(v.scenes.map(s => s.text.trim() ? speak(v.voice, s.text.trim()) : null));
    // A scene lasts at least as long as its line, with a breath either side.
    v = { ...v, scenes: v.scenes.map((s, i) => ({ ...s, seconds: Math.max(s.seconds, voices[i] ? voices[i].duration + 0.5 : 0) })) };
  }
  const tl = timeline(v), frames = Math.round(tl.total * FPS);
  const lines = voices.map((b, i) => b && { buffer: b, at: tl.parts[i].from + 0.2 }).filter(Boolean);
  const sound = (v.music || lines.length) && { ...(await pickAudioCodec()), audio: await mixAudio(v.music, frames / FPS, lines) };
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: mux, width: W, height: H, frameRate: FPS },
    ...(sound && { audio: { codec: sound.mux, sampleRate: 48000, numberOfChannels: 2 } }), fastStart: "in-memory" });
  let failed = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => failed = e });
  enc.configure(config);
  for (let i = 0; i < frames; i++) {
    if (failed) throw failed;
    frame(ctx, v, tl, bmps, i / FPS);
    const f = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(f, { keyFrame: i % (FPS * 2) === 0 });
    f.close();
    while (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
    if (i % 15 === 0) { progress(i / frames); await new Promise(r => setTimeout(r, 0)); }
  }
  await enc.flush();
  if (failed) throw failed;
  if (sound) await encodeAudio(muxer, sound.audio, sound.config);
  muxer.finalize();
  progress(1);
  const blob = new Blob([target.buffer], { type: "video/mp4" });
  blob.vp9 = mux === "vp9"; blob.opus = sound?.mux === "opus";
  return blob;
}

// Shared with clips.js (long video to clips).
export { $, el, call, cards, allBox, showDraft, pickCodec, pickAudioCodec, encodeAudio, caption, wrap, W, H, FPS };

// ---- A review link from Claude Code (/make/?job=<id>): the scripts are already written ----

const job = new URLSearchParams(location.search).get("job");
if (job) {
  $("readStatus").textContent = "Loading the scripts Claude Code sent…";
  call(`/api/job?id=${encodeURIComponent(job)}`, null, "GET").then(out => {
    page = out.page;
    $("readForm").hidden = true;
    $("pTitle").textContent = page.title || page.host;
    $("pHost").textContent = `From Claude Code${page.host ? " · " + page.host : ""}`;
    $("pPages").replaceChildren();
    $("pImgs").replaceChildren(...page.images.map(u => el("img", { src: img(u), alt: "", loading: "lazy", onerror() { this.remove(); } })));
    $("count").replaceChildren(...Array.from({ length: 10 }, (_, i) => el("option", { value: i + 1, textContent: i + 1, selected: i + 1 === out.videos.length })));
    $("pWhy").textContent = "Edit any line, then render. Write the scripts again for new ones.";
    $("pageBox").hidden = false; $("readStatus").textContent = "";
    $("videos").replaceChildren(...out.videos.map(videoCard)); allBox();
  }).catch(err => { $("readStatus").textContent = err.message; $("readStatus").className = "status small bad"; });
}
