// Link to Shorts, the browser half: read → scripts → render (canvas, WebCodecs, MP4) → upload → draft.
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/build/mp4-muxer.mjs";
import { net } from "./nets.js";

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
    const out = await call("/api/scripts", { page, count: +$("count").value, like });
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

// One date format across Dailies, as on /me: "Fri 30 Oct".
const day = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

let plan = [];
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
    $("planList").replaceChildren(el("div", { className: "plan" }, ...plan.map(it => {
      const act = it.kind === "video" ? el("button", { className: "sm", textContent: "Write this video", async onclick() {
        this.disabled = true; this.textContent = "Writing…";
        try {
          const out = await call("/api/scripts", { page: it.page || page, count: 1, angle: it });
          let first = null;
          for (const v of out.videos) { v.angle = v.angle || it.angle; const c = videoCard(v, cards.length); first ??= c; $("videos").append(c); }
          allBox(); this.textContent = "Added above";
          first?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (err) { this.textContent = "Write this video"; this.disabled = false; $("planStatus").textContent = err.message; $("planStatus").className = "status small bad"; }
      } }) : "";
      return el("div", { className: "it" },
        el("input", { type: "checkbox", className: "ck", checked: true, title: "Save as an Idea", onchange() { it.skip = !this.checked; } }),
        el("div", { className: "d", textContent: day(it.date) }),
        el("div", { className: "body" }, el("strong", { textContent: it.angle }), el("div", { textContent: it.hook }),
          it.text ? el("div", { className: "note", textContent: it.text }) : "",
          el("div", { className: "nets" }, el("span", { className: "badge", textContent: it.kind === "video" ? "Video" : "Text" }), ...it.services.map(s => net(s, true)))),
        el("div", { className: "act" }, act));
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
    const text = el("textarea", { value: s.text, rows: 2, ariaLabel: "On-screen line", oninput() { s.text = this.value; } });
    const pick = el("select", { ariaLabel: "Picture", onchange() { s.image = this.value === "" ? null : +this.value;
      const t = s.image == null ? el("div", { className: "noimg" }) : el("img", { src: img(pg(v).images[s.image]), alt: "" }); row.firstChild.replaceWith(t); } },
      el("option", { value: "", textContent: "No picture" }), ...pg(v).images.map((_, i) => el("option", { value: i, textContent: `Picture ${i + 1}`, selected: s.image === i })));
    const row = el("div", { className: "scene" }, thumb, text, pick);
    return row;
  };
  scenes.append(...v.scenes.map(sceneRow));
  const title = el("input", { type: "text", value: v.title, maxLength: 100, oninput() { v.title = this.value; } });
  const caption = el("textarea", { value: v.caption, rows: 3, oninput() { v.caption = this.value; } });
  const hashtags = el("input", { type: "text", value: (v.hashtags || []).map(t => "#" + t).join(" "), oninput() { v.hashtags = this.value.split(/[\s,#]+/).filter(Boolean); } });
  const canvas = el("canvas", { width: W, height: H, className: "preview" });
  const music = musicControls(v);
  const voice = el("select", { onchange() { v.voice = this.value; } },
    el("option", { value: "", textContent: "No voiceover" }),
    ...[["coral", "Coral (warm)"], ["nova", "Nova (bright)"], ["sage", "Sage (calm)"], ["ash", "Ash (low)"], ["onyx", "Onyx (deep)"], ["verse", "Verse (lively)"]]
      .map(([value, textContent]) => el("option", { value, textContent })));
  const state = { v, music, mp4: null, uploaded: null };
  cards.push(state);
  const side = sidePanel(canvas);
  const card = el("div", { className: "card" },
    el("div", { className: "vhead" }, el("span", { className: "badge gold", textContent: `Video ${n + 1}` }), el("h3", { textContent: v.angle })),
    el("div", { className: "video" },
      el("div", {},
        el("div", { className: "grp", textContent: "On screen" }), scenes,
        el("div", { className: "grp", textContent: "Post" }),
        el("label", { className: "f" }, "Title (YouTube, TikTok)", title),
        el("label", { className: "f" }, "Caption", caption),
        el("label", { className: "f" }, "Hashtags (each network gets as many as suit it)", hashtags),
        el("div", { className: "grp", textContent: "Sound" }),
        el("label", { className: "f" }, "Voiceover (reads each line aloud; scenes stretch to fit)", voice), music.box),
      side.box));
  drawStill(canvas, v);

  state.render = () => side.render(state, (p, msg) => msg || `Rendering… ${Math.round(p * 100)}%`,
    progress => render(canvas, v, progress), `dailies-video-${n + 1}.mp4`);
  side.btn.onclick = () => state.render();
  return card;
}

// The preview column of a video or clip card: the still (then the video), progress, the
// result, Render, and the draft box once it's rendered.
function sidePanel(canvas) {
  const status = el("p", { className: "status small" }), result = el("div");
  const btn = el("button", { className: "primary", textContent: "Render" });
  const draftBox = el("div", { hidden: true });
  const box = el("div", { className: "side" }, canvas, status, result, el("div", { className: "actions" }, btn), draftBox);
  // Make the video; `checks` returns a plain-words reason it can't be drafted, if any.
  const render = async (state, say, make, name, checks = () => "") => {
    btn.disabled = true; status.className = "status small";
    try {
      state.mp4 = null; state.uploaded = null; state.poster = poster(canvas);
      box.querySelector("video")?.remove(); canvas.hidden = false; result.replaceChildren(); draftBox.replaceChildren(); draftBox.hidden = true;
      const mp4 = await make((p, msg) => status.textContent = say(p, msg));
      const video = el("video", { src: URL.createObjectURL(mp4), controls: true, playsInline: true });
      canvas.hidden = true; canvas.after(video); status.textContent = "";
      const why = checks(mp4);
      const notes = [mp4.vp9 && "Made as VP9: this browser can't make H.264, and some networks may refuse VP9. Chrome makes H.264.",
        mp4.opus && "Sound made as Opus: this browser can't make AAC, and some networks may refuse Opus."].filter(Boolean);
      result.replaceChildren(el("div", { className: "actions" }, el("span", { className: "badge gold", textContent: "Ready" }),
        el("span", { className: "small muted", textContent: `${(mp4.size / 1048576).toFixed(1)} MB` }),
        el("a", { className: "btn sm", href: video.src, download: name, textContent: "Download" })),
        ...(why ? [el("p", { className: "small bad", textContent: why })] : []), ...notes.map(t => el("p", { className: "note", textContent: t })));
      state.mp4 = why ? null : mp4;
      if (state.mp4) await showDraft(draftBox, state);
      btn.textContent = "Render again"; btn.className = "";
    } catch (err) { status.textContent = err.message; status.className = "status small bad"; }
    btn.disabled = false;
    allBox();
  };
  return { box, btn, render };
}

// A small still of the preview for the video's row on /me, taken just before it renders.
function poster(canvas) {
  const c = el("canvas", { width: 216, height: 384 });
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.75);
}

// ---- Music: a file from the visitor's device, mixed in at render time --------

const cards = [];
const audioCtx = () => (audioCtx.c ??= new AudioContext());

function musicControls(v) {
  const file = el("input", { type: "file", className: "vh", accept: "audio/*,.mp3,.m4a,.wav,.aac,.ogg" });
  const pick = el("label", { className: "btn sm" }, file, "Add music");
  const name = el("span", { className: "small muted", textContent: "A song file from your device (optional)" });
  const start = el("input", { type: "number", min: 0, step: 1, value: 0, style: "width:5.5em", title: "Start the song this many seconds in" });
  const vol = el("input", { type: "range", min: 5, max: 100, value: 80, title: "Volume" });
  const clear = el("button", { type: "button", className: "sm ghost", textContent: "Remove", hidden: true });
  const all = el("button", { type: "button", className: "sm", textContent: "Use on every video", hidden: true });
  const opts = el("div", { className: "actions small", hidden: true }, el("label", { className: "pair" }, "Start at", start, "s"), el("label", { className: "pair" }, "Volume", vol), all, clear);
  const set = (m, label) => {
    v.music = m; name.textContent = label || "A song file from your device (optional)"; opts.hidden = !m; clear.hidden = !m; all.hidden = !m || cards.length < 2;
    pick.lastChild.textContent = m ? "Change music" : "Add music";
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
  const box = el("div", {},
    el("label", { className: "f", textContent: "Music" }), el("div", { className: "actions", style: "margin-top:6px" }, pick, name), opts,
    el("p", { className: "note", textContent: "Use music you have the rights to. Networks can mute or block songs they recognise." }));
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
  const v = state.v, lines = (v.scenes || []).map(x => x.text);
  const { results } = await call("/api/draft", { video: id, channels: chosen, caption: v.caption, title: v.title, hashtags: v.hashtags, angle: v.angle,
    hook: v.hook || lines[0] || "", lines, link: v.scenes ? pg(v)?.url || "" : "", poster: state.poster });
  return results;
}

async function showDraft(box, state) {
  channels ??= (await call("/api/channels", null, "GET")).channels;
  if (!channels.length) { box.append(el("p", { className: "note", textContent: "No Buffer channels that take video are connected." })); box.hidden = false; return; }
  const ticks = channels.map(c => el("input", { type: "checkbox", value: c.id, checked: ["instagram", "tiktok", "youtube"].includes(c.service) }));
  const btn = el("button", { className: "primary", textContent: "Draft to Buffer" });
  const out = el("div", { className: "status small" });
  box.append(el("label", { className: "f", textContent: "Draft it to" }),
    el("div", {}, ...channels.map((c, i) => el("label", { className: "ch" }, ticks[i], net(c.service)))), el("div", { className: "actions" }, btn), out);
  box.hidden = false;
  btn.onclick = async () => {
    const chosen = ticks.filter(t => t.checked).map(t => t.value);
    if (!chosen.length) { out.textContent = "Pick at least one channel."; return; }
    btn.disabled = true; out.className = "status small"; out.textContent = "Uploading and drafting…";
    try {
      const results = await draft(state, chosen);
      out.replaceChildren(...results.map(r => el("div", { className: r.ok ? "good" : "bad", textContent: r.ok ? `${r.channel}: in your Buffer drafts` : `${r.channel}: ${r.error}` })));
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
  $("renderAll").className = made < cards.length ? "primary" : "";
  $("draftAll").disabled = !made; $("allDraft").hidden = !made;
  if (made && !$("allTicks").children.length) {
    channels ??= (await call("/api/channels", null, "GET")).channels;
    $("allTicks").replaceChildren(...channels.map(c => el("label", { className: "ch" },
      el("input", { type: "checkbox", value: c.id, checked: ["instagram", "tiktok", "youtube"].includes(c.service) }), net(c.service))));
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

function wrap(ctx, text, max, balance = false) {
  const greedy = m => {
    const lines = []; let line = "";
    for (const w of text.split(" ")) { const t = line ? line + " " + w : w; if (ctx.measureText(t).width > m && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line);
    return lines;
  };
  const lines = greedy(max);
  if (!balance || lines.length < 2) return lines;
  // Even lines, not a lone word under a full one: the narrowest width that still needs no more lines.
  let lo = 0, hi = max;
  while (hi - lo > 4) { const mid = (lo + hi) / 2; if (greedy(mid).length > lines.length) lo = mid; else hi = mid; }
  return greedy(hi);
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
  const font = s => `800 ${s}px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`, max = W - 140;
  let size = 104; ctx.font = font(size);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  let lines = wrap(ctx, text.toUpperCase(), max, true);
  // One word wider than the frame (a long web address) shrinks the type instead of running off the edges.
  const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
  if (widest > max) { size = Math.floor(size * max / widest); ctx.font = font(size); lines = wrap(ctx, text.toUpperCase(), max, true); }
  const lh = Math.round(size * 1.17), y0 = H * 0.66 - (lines.length - 1) * lh / 2;
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
export { $, el, call, cards, allBox, sidePanel, pickCodec, pickAudioCodec, encodeAudio, caption, wrap, W, H, FPS };

// ---- Make more like this (/make/?like=<kept post>): read its link, and write in its manner ----

let like = null;
const likeId = new URLSearchParams(location.search).get("like");
if (likeId) {
  $("readStatus").textContent = "Loading the post you kept…";
  call(`/api/like?id=${encodeURIComponent(likeId)}`, null, "GET").then(out => {
    like = out;
    $("likeNote").textContent = `Making more like “${out.title}”: new angles, in the manner that worked. `;
    $("likeNote").append(el("a", { href: "/make/", textContent: "Start fresh instead" }));
    $("likeNote").hidden = false;
    $("url").value = out.link;
    $("readStatus").textContent = "";
    if (out.link) $("readForm").requestSubmit();
  }).catch(err => { $("readStatus").textContent = err.message; $("readStatus").className = "status small bad"; });
}

// ---- A review link from Claude Code (/make/?job=<id>): the scripts are already written ----

const job = new URLSearchParams(location.search).get("job");
if (job) {
  $("readStatus").textContent = "Loading the scripts Claude Code sent…";
  call(`/api/job?id=${encodeURIComponent(job)}`, null, "GET").then(out => {
    page = out.page;
    $("starts").hidden = true;
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
