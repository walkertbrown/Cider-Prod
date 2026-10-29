// Link to Shorts: read a page, write scripts, host the videos the browser
// renders, and draft them into Buffer.
//   POST /api/read     {urls} (1–5) → the pages' titles, text, images, and a suggested count
//   POST /api/scripts  {page, count, angle?} → video scripts (language model, capped)
//   POST /api/voice    {text, voice} → MP3 of one line read aloud (text-to-speech, capped)
//   GET  /api/img?u=   an image from the page, re-served so the canvas can encode it
//   PUT  /api/upload   an MP4 from the browser → {id, url}
//   GET  /api/channels the account's Buffer channels
//   GET  /api/job?id=  a video job made from Claude Code (src/mcp.js), for review here
//   POST /api/draft    {video, channels, caption, title, …, poster} → one Buffer draft per channel
//   POST /api/plan     {page, start, weeks, perWeek} → dated items for the connected networks (capped)
//   POST /api/ideas    {items} → one Buffer Idea per item (Buffer has no API to delete ideas)
//   POST /api/transcribe  a 16 kHz mono WAV piece of a long video's sound → timed words (speech-to-text, capped by minutes)
//   POST /api/moments  {segments, duration, count} → the best stand-alone clips in a long video (capped)
//   POST /api/shot     {url} → the page as one tall phone screenshot (Cloudflare's browser; kept a day; capped) with its texts and where they sit
//   POST /api/scroll   {segments, elements, height, page, duration} → where to scroll while the creator talks, and the post (counts as a script run)
//   POST /api/say      {page, seconds} → one spoken paragraph for the creator to read to camera (counts as a script run)
//   GET  /v/<id>.mp4   the hosted video, public, for Buffer to fetch (with ranges)

const SCRIPT_MODEL = "gpt-5.4-mini";
const CAPS = { script: [20, 200], voice: [150, 1500], minutes: [60, 600], shot: [10, 100] }; // a day: per account, overall
const CAP_WORDS = { script: "script runs", voice: "voiceover lines", minutes: "minutes of transcription", shot: "page screenshots" };
const WAV_MAX = 20 * 1024 * 1024; // 16 kHz mono 16-bit: about 10 minutes, under the speech-to-text limit of 25 MB
const VOICE_MODEL = "gpt-4o-mini-tts";
const VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]);
const VIDEO_TTL = 30 * 86400, VIDEO_MAX = 25 * 1024 * 1024;
const VIDEO_NETS = new Set(["instagram", "tiktok", "youtube", "facebook", "linkedin", "twitter", "threads", "bluesky", "mastodon", "pinterest"]);

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const today = () => new Date().toISOString().slice(0, 10);
const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
  .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const strip = s => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function safeHttp(s) {
  try { const u = new URL(String(s).trim()); return /^https?:$/.test(u.protocol) && !/^(localhost|127\.|10\.|192\.168\.|\[)/.test(u.hostname) ? u : null; } catch { return null; }
}

// ---- Reading a page --------------------------------------------------------

function meta(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1] || "") : "";
}

function jsonLdProducts(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = x => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk);
        if (/Product/i.test([].concat(x["@type"] || []).join())) out.push({ name: x.name, price: [].concat(x.offers || [])[0]?.price, currency: [].concat(x.offers || [])[0]?.priceCurrency });
        Object.values(x).forEach(walk); };
      walk(JSON.parse(m[1]));
    } catch {}
  }
  return out.slice(0, 5);
}

export async function readPage(url) {
  const r = await fetch(url.toString(), { headers: { "user-agent": "Mozilla/5.0 (compatible; TapBot/1.0; +https://tap.bananafest-destiny.com)", accept: "text/html,*/*" }, redirect: "follow" });
  if (!r.ok) return { error: `The page answered ${r.status}.` };
  if (!(r.headers.get("content-type") || "").includes("html")) return { error: "That link isn't a web page." };
  const html = (await r.text()).slice(0, 1_500_000);
  const base = new URL(r.url);
  const body = html.replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ");
  const title = meta(html, "og:title") || strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const description = meta(html, "og:description") || meta(html, "description");
  const blocks = [];
  const seen = new Set();
  for (const m of body.matchAll(/<(h1|h2|h3|p|li|blockquote|td|figcaption)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = strip(m[2]);
    if (t.length < 25 || seen.has(t)) continue;
    seen.add(t); blocks.push((m[1][0] === "h" ? "## " : "") + t);
  }
  const text = blocks.join("\n").slice(0, 12000);
  const imgs = [];
  const addImg = src => { try { const u = new URL(decode(src), base); if (/^https?:$/.test(u.protocol) && !/\.(svg|ico|gif)(\?|$)/i.test(u.pathname) && !/(sprite|icon|logo|avatar|pixel|badge|favicon)/i.test(u.pathname) && !imgs.includes(u.href)) imgs.push(u.href); } catch {} };
  for (const k of ["og:image", "og:image:url", "twitter:image"]) { const v = meta(html, k); if (v) addImg(v); }
  for (const m of body.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = tag.match(/\s(?:data-src|src)=["']([^"']+)["']/i)?.[1] || tag.match(/srcset=["']([^"'\s]+)/i)?.[1];
    const w = +(tag.match(/width=["']?(\d+)/i)?.[1] || 999);
    if (src && !src.startsWith("data:") && w >= 200) addImg(src);
    if (imgs.length >= 16) break;
  }
  return { url: r.url, host: base.hostname.replace(/^www\./, ""), title, description, blocks, images: imgs, products: jsonLdProducts(html) };
}

// Several pages read as one source: the first is the main page (its address goes on the
// end card); lines repeated across pages (menus, footers) count once.
// A Shopify store's public catalogue: /products.json (or a collection's), plus /meta.json for its name and currency.
export async function readStore(u) {
  const get = async path => {
    const r = await fetch(u.origin + path, { headers: { "user-agent": "Mozilla/5.0 (compatible; TapBot/1.0; +https://tap.bananafest-destiny.com)", accept: "application/json" }, cf: { cacheTtl: 1800, cacheEverything: true } });
    return r.ok && (r.headers.get("content-type") || "").includes("json") ? r.json().catch(() => null) : null;
  };
  const coll = u.pathname.match(/\/collections\/([^/]+)/)?.[1];
  const [list, meta] = await Promise.all([get(`${coll ? `/collections/${coll}` : ""}/products.json?limit=50`), get("/meta.json")]);
  const products = (list?.products || []).filter(p => p.handle && p.title).map(p => ({
    title: decode(p.title).slice(0, 120), url: `${u.origin}/products/${p.handle}`, type: p.product_type || "", vendor: p.vendor || "",
    price: p.variants?.[0]?.price || "", was: p.variants?.[0]?.compare_at_price || "",
    images: (p.images || []).map(i => i.src).filter(Boolean).slice(0, 6), text: strip(p.body_html || "").slice(0, 1500),
  }));
  return products.length ? { name: meta?.name || u.hostname, currency: meta?.currency || "", collection: coll || "", products } : null;
}

export async function readPages(urls) {
  const read = await Promise.all(urls.map(u => readPage(u).catch(e => ({ error: `Couldn't read it: ${e.message}` }))));
  const ok = read.filter(p => !p.error);
  const failed = urls.map((u, i) => read[i].error ? `${u.hostname}${u.pathname}: ${read[i].error}` : "").filter(Boolean);
  if (!ok.length) return { error: failed.join(" ") };
  const seen = new Set(), budget = Math.floor(12000 / ok.length);
  const sections = ok.map(p => {
    const fresh = p.blocks.filter(b => !seen.has(b) && seen.add(b));
    let text = ""; for (const b of fresh) { if (text.length + b.length > budget) break; text += b + "\n"; }
    return { fresh, text: `# Page: ${p.title} (${p.url})\n${p.description ? p.description + "\n" : ""}${text}` };
  });
  const images = [...new Set(ok.flatMap(p => p.images))].slice(0, 24);
  // How much there is to say: separate substantial statements, and how many carry a number.
  const points = sections.flatMap(x => x.fresh).filter(b => !b.startsWith("## ") && b.split(" ").length >= 10);
  const withNumbers = points.filter(b => /\d/.test(b)).length;
  const suggested = Math.max(1, Math.min(10, Math.round(points.length / 4 + withNumbers / 6)));
  const why = `${points.length} substantial point${points.length === 1 ? "" : "s"}${withNumbers ? ` (${withNumbers} with numbers)` : ""} and ${images.length} image${images.length === 1 ? "" : "s"}`;
  const main = ok[0];
  return { url: main.url, host: main.host, title: main.title, description: main.description, pages: ok.map(p => ({ url: p.url, title: p.title })),
    text: sections.map(x => x.text).join("\n"), images, products: ok.flatMap(p => p.products).slice(0, 10), suggested, why, failed };
}

// ---- Scripts ---------------------------------------------------------------

const SCRIPT_RULES = `You write scripts for vertical short videos (Reels, TikTok, YouTube Shorts) that promote a web page.
Each video is 15 to 30 seconds and has 4 to 7 scenes. Each scene shows one of the page's images (by index) with one short line of on-screen text.
Rules:
- Use only facts that are on the page. Never invent numbers, prices, reviews or claims.
- Scene 1 is the hook: a specific, surprising or useful line from the page, not "Check this out".
- Each video takes a different angle (a different fact, feature, use or audience). If there isn't enough on the page for distinct angles, return fewer videos and say why in "note".
- On-screen lines are at most 12 words, plain words, no hashtags, no emoji.
- The last scene is the call to action and names the site (the host given).
- The text may come from several pages of one site: the first is the main page, the others are feature or detail pages. Use the feature pages for angles, and send people to the main site.
- seconds per scene: 2.5 to 5, longer for longer lines.
- Lines may also be read aloud by a narrator, so write them to sound natural spoken. In the last scene name the site the way a person says it (the host name, no "https", no slashes or paths).
- caption: the post text for the networks, 1 to 3 short sentences plus the site address, at most 260 characters, no hashtags. title: at most 90 characters, for YouTube. hashtags: 3 to 6 relevant single words or CamelCase phrases, without "#".
Return JSON only: {"note": string, "videos": [{"angle": string, "title": string, "caption": string, "hashtags": [string], "scenes": [{"text": string, "image": integer or null, "seconds": number}]}]}`;

export const BUILD_VOICE = `

This is a build-in-public update: the source is a maker's notes on what they just built or shipped, not a sales page.
- Speak as the maker ("we shipped", "I built", "today"), concrete and honest. Use the real numbers in the notes.
- Hook with the most interesting change or number. One clear point per video.
- Only what is in the maker's notes is new. Anything else from the page is background: never call it shipped, new or "today".
- Several videos: each takes a different angle on what shipped (the change, how it works, who it's for, a number), not other features.
- The call to action invites people to try it or follow along, and names the site if one is given.`;

// "Make more like this": an earlier video the owner kept because it worked.
const likeRules = like => `

The owner kept an earlier video because it did well. Write new ones like it: the same kind of hook, length, tone and call to action, each on a new angle. Don't repeat its lines.
Its angle: ${String(like.angle || "").slice(0, 80)}
Its hook: ${String(like.hook || "").slice(0, 140)}
Its lines: ${[].concat(like.lines || []).slice(0, 8).map(l => String(l).slice(0, 120)).join(" / ")}
Its caption: ${String(like.caption || "").slice(0, 500)}`;

export async function writeScripts(env, page, count, extra = "") {
  const input = `Host: ${page.host}\nURL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description}\n` +
    (page.products?.length ? `Products: ${JSON.stringify(page.products)}\n` : "") +
    `Images (index: url): ${page.images.map((u, i) => `${i}: ${u.split("/").pop().slice(0, 60)}`).join("; ") || "none"}\n\nPage text:\n${String(page.text || "").slice(0, 14000)}\n\nWrite ${count} video${count === 1 ? "" : "s"}.`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: SCRIPT_MODEL, response_format: { type: "json_object" }, reasoning_effort: "low",
      messages: [{ role: "system", content: SCRIPT_RULES + extra }, { role: "user", content: input }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error?.message || `The script writer answered ${r.status}.` };
  let out; try { out = JSON.parse(d.choices[0].message.content); } catch { return { error: "The script writer returned something unreadable. Try again." }; }
  const n = page.images.length;
  out.videos = (out.videos || []).slice(0, 10).map(v => ({
    angle: String(v.angle || ""), title: String(v.title || "").slice(0, 100), caption: String(v.caption || "").slice(0, 500), hashtags: cleanTags(v.hashtags),
    scenes: (v.scenes || []).slice(0, 8).map(s => ({ text: String(s.text || "").slice(0, 120), image: Number.isInteger(s.image) && s.image >= 0 && s.image < n ? s.image : null, seconds: Math.min(6, Math.max(2, +s.seconds || 3)) })),
  })).filter(v => v.scenes.length);
  return out;
}

// ---- The planner: a month of dated items from the page and the connected networks ----

const TEXT_NETS = new Set(["twitter", "bluesky", "threads", "linkedin", "facebook", "mastodon"]);
const PLAN_RULES = `You plan a month of social posts that promote a web page (or a store). You get the page, its products if any, the networks the owner has connected, and the dates to use.
Rules:
- One item per date given, in order. Each item is either a short vertical video (for instagram, tiktok, youtube) or a text post (for twitter, bluesky, threads, linkedin, facebook, mastodon). Only use networks from the connected list. A video item goes to all connected video networks; a text item to all connected text networks.
- If there are no text networks, every item is a video. If there are no video networks, every item is text.
- Every item has its own angle: a different feature, product, use, question or number from the page. No two items repeat. For a store, spread items across different products.
- Use only facts that are on the page. Never invent numbers, prices, reviews or claims.
- "angle" is a short label (under 8 words). "hook" is the first line someone sees or hears (under 12 words). "notes" says in one or two sentences what the post covers, so it can be written later. For a text item, "text" is the finished post (under 260 characters, no hashtags); for a video item, "text" is "".
Return JSON: {"items":[{"date":"YYYY-MM-DD","kind":"video"|"text","angle":"...","hook":"...","notes":"...","text":"..."}]}`;

async function writePlan(env, page, dates, nets) {
  const video = nets.filter(n => !TEXT_NETS.has(n)), text = nets.filter(n => TEXT_NETS.has(n));
  const input = `Host: ${page.host}\nURL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description}\n` +
    (page.store ? `Store products: ${JSON.stringify(page.store.products.slice(0, 30).map(p => ({ title: p.title, price: p.price, type: p.type })))}\n` : "") +
    `Video networks connected: ${video.join(", ") || "none"}\nText networks connected: ${text.join(", ") || "none"}\nDates: ${dates.join(", ")}\n\nPage text:\n${String(page.text || "").slice(0, 12000)}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: SCRIPT_MODEL, response_format: { type: "json_object" }, reasoning_effort: "low",
      messages: [{ role: "system", content: PLAN_RULES }, { role: "user", content: input }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error?.message || `The planner answered ${r.status}.` };
  let out; try { out = JSON.parse(d.choices[0].message.content); } catch { return { error: "The planner returned something unreadable. Try again." }; }
  const items = (out.items || []).slice(0, dates.length).map((it, i) => {
    const kind = it.kind === "text" && text.length || !video.length ? "text" : "video";
    return { date: dates[i], kind, services: kind === "text" ? text : video, angle: String(it.angle || "").slice(0, 80), hook: String(it.hook || "").slice(0, 140),
      notes: String(it.notes || "").slice(0, 400), text: kind === "text" ? String(it.text || "").slice(0, 300) : "" };
  });
  return { items };
}

const CREATE_IDEA = `mutation($i:CreateIdeaInput!){ createIdea(input:$i){ __typename ... on Idea { id } ... on InvalidInputError { message } ... on UnauthorizedError { message } ... on UnexpectedError { message } ... on LimitReachedError { message } } }`;

// One daily counter per account and one overall, in KV (approximate under races; fine as a cap).
export async function underCap(env, acct, kind, n = 1) {
  const [perAcct, overall] = CAPS[kind], tag = kind === "script" ? "" : kind + ":";
  const kA = `cap:${tag}${today()}:${acct}`, kAll = `cap:${tag}${today()}:all`;
  const [a, all] = await Promise.all([env.TAP.get(kA), env.TAP.get(kAll)]);
  if (+a + n > perAcct) return +a >= perAcct ? `You've used today's ${perAcct} ${CAP_WORDS[kind]}. More tomorrow.` : `That needs ${n} ${CAP_WORDS[kind]} and ${perAcct - +a} are left today.`;
  if (+all + n > overall) return "Dailies has reached today's limit for everyone. More tomorrow.";
  await Promise.all([env.TAP.put(kA, String(+a + n), { expirationTtl: 2 * 86400 }), env.TAP.put(kAll, String(+all + n), { expirationTtl: 2 * 86400 })]);
  return "";
}

// ---- Long video to clips: the browser sends the sound in pieces, then the timed sentences ----

const MOMENT_RULES = `You pick the best moments in a long video to cut into short vertical clips. You get the transcript as timed sentences [start-end seconds] and how many clips to pick.
Rules:
- Each clip is one stand-alone moment: it makes sense without the rest of the video, starts at the start of a sentence and ends at the end of one. Prefer a strong first line (a claim, a question, a number, a surprise).
- Each clip is 20 to 45 seconds long if possible, never under 12 or over 60. Clips never overlap. Use the exact sentence start and end times given.
- Fewer clips than asked is fine if the video doesn't have that many good moments.
- "title" is a short headline for the clip (under 60 characters). "caption" is the post text (one or two sentences, no hashtags). "hashtags" is 3 to 5 tags without #. Use only what is said; never invent facts.
Return JSON: {"clips":[{"start":0.0,"end":0.0,"title":"...","caption":"...","hashtags":["..."]}]}`;

async function transcribe(env, wav) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error?.message || `The speech-to-text service answered ${r.status}.` };
  const t = x => Math.round(x * 100) / 100;
  return { duration: +d.duration || 0, language: d.language || "",
    words: (d.words || []).map(w => ({ w: String(w.word), s: t(w.start), e: t(w.end) })),
    segments: (d.segments || []).map(g => ({ s: t(g.start), e: t(g.end), t: String(g.text).trim() })) };
}

async function pickMoments(env, segments, duration, count) {
  const input = `Video length: ${Math.round(duration)} seconds. Pick up to ${count} clip${count === 1 ? "" : "s"}.\n\nTranscript:\n` +
    segments.map(g => `[${g.s.toFixed(1)}-${g.e.toFixed(1)}] ${g.t}`).join("\n").slice(0, 60000);
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: SCRIPT_MODEL, response_format: { type: "json_object" }, reasoning_effort: "low",
      messages: [{ role: "system", content: MOMENT_RULES }, { role: "user", content: input }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error?.message || `The clip picker answered ${r.status}.` };
  let out; try { out = JSON.parse(d.choices[0].message.content); } catch { return { error: "The clip picker returned something unreadable. Try again." }; }
  const clips = [];
  for (const c of (out.clips || []).map(c => ({ start: Math.max(0, +c.start || 0), end: Math.min(duration, +c.end || 0), title: String(c.title || "").slice(0, 100),
    caption: String(c.caption || "").slice(0, 500), hashtags: cleanTags(c.hashtags) })).sort((a, b) => a.start - b.start)) {
    if (c.end - c.start < 5 || c.end - c.start > 90) continue;
    if (clips.length && c.start < clips.at(-1).end) continue;
    clips.push(c);
  }
  return { clips: clips.slice(0, count) };
}

// ---- Put yourself in it: the page as one tall screenshot, and where to scroll while the creator talks ----

const SHOT_TTL = 86400, SHOT_VIEW = { width: 390, height: 844, deviceScaleFactor: 2 }, SHOT_MAX = 12 * 1048576;
const SHOT_ELEMENTS = "h1,h2,h3,p,li,button,a,img,[role=button],label,strong";
const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
export const shotKey = async url => `shot:${await sha256(url.href)}`;

// Base64 in pieces: one String.fromCharCode over megabytes blows the stack.
function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(s);
}

// One call to Cloudflare's browser. The free plan allows a request every 10 seconds, so a 429 waits and tries again.
async function browser(env, what, body) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/${what}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.BR_TOKEN}` }, body: JSON.stringify(body) });
    if (r.status === 429 && tries < 2) { await new Promise(ok => setTimeout(ok, 1000 * Math.min(15, +r.headers.get("retry-after") || 10))); continue; }
    return r;
  }
}

// The page as a phone sees it, top to bottom, as a JPEG data URL, with its texts and their tops (CSS px).
export async function screenshot(env, url) {
  if (!env.BR_TOKEN || !env.CF_ACCOUNT_ID) return { error: "Page screenshots aren't set up on this Dailies." };
  const gotoOptions = { waitUntil: "networkidle0", timeout: 20000 };
  let shot = await browser(env, "screenshot", { url: url.href, viewport: SHOT_VIEW, gotoOptions, screenshotOptions: { fullPage: true, type: "jpeg", quality: 82 } });
  // A page too tall for one picture: the first 4000 px instead.
  if (!shot.ok) shot = await browser(env, "screenshot", { url: url.href, viewport: { ...SHOT_VIEW, height: 4000 }, gotoOptions, screenshotOptions: { type: "jpeg", quality: 82 } });
  if (!shot.ok) return { error: `The page couldn't be photographed (${shot.status}). Check that the link opens.` };
  const bytes = new Uint8Array(await shot.arrayBuffer());
  if (bytes.length > SHOT_MAX) return { error: "That page is too long to photograph." };
  let elements = [];
  const scrape = await browser(env, "scrape", { url: url.href, viewport: SHOT_VIEW, gotoOptions, elements: [{ selector: SHOT_ELEMENTS }] }).catch(() => null);
  if (scrape?.ok) {
    const d = await scrape.json().catch(() => ({})), seen = new Set();
    for (const e of d.result?.[0]?.results || []) {
      const text = String(e.text || e.attributes?.find(a => a.name === "alt")?.value || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const top = Math.round(+e.top || 0), k = `${top}:${text}`;
      if (!text || !(e.height > 0) || top < 0 || seen.has(k)) continue;
      seen.add(k); elements.push({ text, top, height: Math.round(e.height), left: Math.round(+e.left || 0), width: Math.round(+e.width || 0) });
    }
    elements = elements.sort((a, b) => a.top - b.top).slice(0, 150);
  }
  return { jpeg: `data:image/jpeg;base64,${b64(bytes)}`, width: SHOT_VIEW.width, elements };
}

const SCROLL_RULES = `A creator recorded themselves talking about a web page. Their video will be shown over a screenshot of the page, which scrolls behind them. You get what they said as timed sentences [start-end seconds], and the page's texts, each as "#index top: text" with the top in px from the top of the page. The page is H px tall; the visible window is 844 px.
Decide where the page is scrolled to while they talk: when they mention something that is on the page, scroll so it is in view (y = that text's top minus 150, at least 0, at most H minus 844). The first keyframe is t 0, y 0. Give 3 to 8 keyframes in time order; the page holds still between them and glides to the next. Only scroll back up when they clearly return to something. If nothing they say matches the page, pace evenly down it, ending near the bottom.
When they tell the viewer to press, tap, click or hit a named button or link that is on the page, that keyframe's "tap" is the element's index and its y keeps the element in view; otherwise "tap" is null. Only for a real instruction, never a passing mention.
Also write the post: "title" (under 60 characters, what the video is about, in their words), "caption" (one or two sentences in their voice, under 300 characters, no hashtags), "hashtags" (3 to 6, without #).
Return JSON: {"keyframes":[{"t":0,"y":0,"tap":null}],"title":"...","caption":"...","hashtags":["..."]}`;

async function scrollPlan(env, segments, elements, height, page, duration) {
  const input = `Page: ${String(page.title || "").slice(0, 120)} (${String(page.host || "").slice(0, 80)}). H = ${height}. Video length ${Math.round(duration)} seconds.\n\nWhat they said:\n` +
    segments.map(g => `[${g.s.toFixed(1)}-${g.e.toFixed(1)}] ${g.t}`).join("\n").slice(0, 12000) +
    `\n\nOn the page (#index top: text):\n` + (elements.map((e, i) => `#${i} ${e.top}: ${e.text}`).join("\n").slice(0, 12000) || "(nothing could be read)");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: SCRIPT_MODEL, response_format: { type: "json_object" }, reasoning_effort: "low",
      messages: [{ role: "system", content: SCROLL_RULES }, { role: "user", content: input }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error?.message || `The planner answered ${r.status}.` };
  let out; try { out = JSON.parse(d.choices[0].message.content); } catch { return { error: "The planner returned something unreadable. Try again." }; }
  const max = Math.max(0, height - SHOT_VIEW.height);
  // A tapped element becomes the point to press, in the page's own px; only elements with a known place can be tapped.
  const keyframes = (Array.isArray(out.keyframes) ? out.keyframes : []).slice(0, 8)
    .map(k => {
      const e = Number.isInteger(k.tap) ? elements[k.tap] : null;
      return { t: Math.max(0, Math.min(duration, +k.t || 0)), y: Math.max(0, Math.min(max, Math.round(+k.y || 0))),
        ...(e?.width > 0 && e.height > 0 ? { tap: { x: Math.round(e.left + e.width / 2), y: Math.round(e.top + e.height / 2) } } : {}) };
    }).sort((a, b) => a.t - b.t);
  if (!keyframes.length || keyframes[0].t > 0) keyframes.unshift({ t: 0, y: 0 });
  return { keyframes, title: String(out.title || "").slice(0, 100), caption: String(out.caption || "").slice(0, 500), hashtags: cleanTags(out.hashtags) };
}

// ---- What to say: one paragraph for the creator to read to camera -------------

const SAY_RULES = `You write what the owner of a web page will say to camera, in one take, for a short vertical video. One spoken paragraph in the first person, plain and conversational, like telling a friend: what the page is for, who it is for, and one or two concrete things on it worth pointing at, named as they appear on the page so the page can be scrolled to them. Use only facts that are on the page; never invent numbers, prices or reviews. No greeting like "hey guys", no hashtags, no stage directions, no emoji. It must read aloud in the seconds given, at about 2.4 words a second. End with what to do next (the link is in the bio or the caption).
Return JSON: {"text":"..."}`;

async function sayScript(env, page, seconds) {
  const input = `Host: ${page.host}\nURL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description}\n` +
    (page.products?.length ? `Products: ${JSON.stringify(page.products).slice(0, 3000)}\n` : "") +
    `Seconds: ${seconds} (about ${Math.round(seconds * 2.4)} words).\n\nPage text:\n${String(page.text || "").slice(0, 12000)}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: SCRIPT_MODEL, response_format: { type: "json_object" }, reasoning_effort: "low",
      messages: [{ role: "system", content: SAY_RULES }, { role: "user", content: input }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error?.message || `The writer answered ${r.status}.` };
  let out; try { out = JSON.parse(d.choices[0].message.content); } catch { return { error: "The writer returned something unreadable. Try again." }; }
  const text = String(out.text || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  return text ? { text } : { error: "The writer came back empty. Try again." };
}

// ---- Drafting --------------------------------------------------------------

export const cleanTags = list => [...new Set([].concat(list || []).map(t => String(t).replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean))].slice(0, 8);

// The post text each network gets: the caption, plus as many hashtags as suit it.
export function captionFor(service, caption, hashtags) {
  const tags = n => cleanTags(hashtags).slice(0, n).map(t => "#" + t).join(" ");
  const fit = (text, max) => text.length <= max ? text : text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  const c = caption.trim();
  switch (service) {
    case "instagram": return fit(`${c}\n\n${tags(5)}`.trim(), 2200);
    case "tiktok": return fit(`${c} ${tags(4)}`.trim(), 2200);
    case "youtube": return fit(`${c}\n\n${tags(3)} #Shorts`.trim(), 5000);
    case "twitter": return fit(`${c} ${tags(1)}`.trim(), 280);
    case "bluesky": return fit(c, 300);
    case "threads": return fit(`${c} ${tags(1)}`.trim(), 500);
    case "linkedin": case "facebook": return fit(`${c}\n\n${tags(3)}`.trim(), 3000);
    default: return fit(c, 500);
  }
}

const CREATE_TAG = `mutation($i:CreateTagInput!){ createTag(input:$i){ __typename ... on TagActionSuccess { tag { id } } } }`;

export function postInput(ch, { text, video, title, category, tagIds = [] }) {
  const i = { channelId: ch.id, text, mode: "addToQueue", schedulingType: "automatic", saveToDraft: true, tagIds,
    assets: video ? [{ video: { url: video } }] : [] };
  const t = (title || text.split("\n")[0]).slice(0, 100);
  if (ch.service === "instagram") i.metadata = { instagram: { type: video ? "reel" : "post", shouldShareToFeed: true } };
  if (ch.service === "youtube") i.metadata = { youtube: { title: t, categoryId: category || "22" } };
  if (ch.service === "tiktok") i.metadata = { tiktok: { title: t } };
  return i;
}

export const CREATE_POST = `mutation($i:CreatePostInput!){ createPost(input:$i){ __typename ... on PostActionSuccess { post { id } }
  ... on InvalidInputError { message } ... on LimitReachedError { message } ... on UnauthorizedError { message } ... on UnexpectedError { message } ... on RestProxyError { message } ... on NotFoundError { message } } }`;

// ---- Routes ----------------------------------------------------------------

export async function serveVideo(env, req, id) {
  const { value, metadata } = await env.TAP.getWithMetadata(`v:${id}`, { type: "arrayBuffer" });
  if (!value) return new Response("Not found", { status: 404 });
  const size = value.byteLength;
  const headers = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "public, max-age=86400", "x-robots-tag": "noindex" };
  const m = (req.headers.get("range") || "").match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(value.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(req.method === "HEAD" ? null : value, { headers: { ...headers, "content-length": String(size) } });
}


export async function api(req, env, path, { acct, user }, d) {
  const url = new URL(req.url);
  if (path === "/api/read" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const raw = [].concat(body.urls || body.url || []).map(String).filter(x => x.trim());
    const urls = raw.map(safeHttp);
    if (!urls.length) return json({ error: "Paste a web address." }, 400);
    if (urls.length > 5) return json({ error: "Up to 5 links at a time." }, 400);
    const bad = raw.find((x, i) => !urls[i]);
    if (bad) return json({ error: `That isn't a web address: ${bad.slice(0, 80)}` }, 400);
    try {
      const [page, store] = await Promise.all([readPages(urls), readStore(urls[0]).catch(() => null)]);
      if (store) return json(page.error ? { url: urls[0].href, host: urls[0].hostname, title: store.name, description: "", pages: [], text: "", images: [], products: [],
        suggested: 1, why: "", failed: [page.error], store } : { ...page, store });
      return json(page, page.error ? 422 : 200);
    }
    catch (e) { return json({ error: `Couldn't read the page: ${e.message}` }, 422); }
  }
  if (path === "/api/scripts" && req.method === "POST") {
    const body = await req.json().catch(() => ({})), { page, count } = body;
    if (!page?.text && !page?.description) return json({ error: "Read a page first." }, 400);
    const capped = await underCap(env, acct, "script");
    if (capped) return json({ error: capped }, 429);
    const { angle, like } = body;
    const extra = (page.build ? BUILD_VOICE : "") + (like ? likeRules(like) : "") + (angle ? `\n\nWrite this one for a planned post. Its angle: ${String(angle.angle || "").slice(0, 80)}. Its hook: ${String(angle.hook || "").slice(0, 140)}. What it covers: ${String(angle.notes || "").slice(0, 400)}` : "");
    const out = await writeScripts(env, page, Math.max(1, Math.min(10, +count || 1)), extra);
    return json(out, out.error ? 502 : 200);
  }
  if (path === "/api/transcribe" && req.method === "POST") {
    const wav = await req.arrayBuffer();
    const v = new DataView(wav);
    if (wav.byteLength < 44 || v.getUint32(0) !== 0x52494646 || v.getUint32(8) !== 0x57415645) return json({ error: "Send the sound as WAV." }, 415);
    if (wav.byteLength > WAV_MAX) return json({ error: "That piece is too long. Up to 10 minutes at a time." }, 413);
    const minutes = Math.max(1, Math.ceil((wav.byteLength - 44) / (v.getUint32(28, true) || 32000) / 60));
    const capped = await underCap(env, acct, "minutes", minutes);
    if (capped) return json({ error: capped }, 429);
    const out = await transcribe(env, wav);
    return json(out, out.error ? 502 : 200);
  }
  if (path === "/api/moments" && req.method === "POST") {
    const { segments, duration, count } = await req.json().catch(() => ({}));
    const segs = (Array.isArray(segments) ? segments : []).slice(0, 3000).map(g => ({ s: +g.s || 0, e: +g.e || 0, t: String(g.t || "").slice(0, 400) })).filter(g => g.t);
    if (!segs.length) return json({ error: "Nobody speaks in this video, so there's nothing to pick from." }, 400);
    const capped = await underCap(env, acct, "script");
    if (capped) return json({ error: capped }, 429);
    const out = await pickMoments(env, segs, +duration || segs.at(-1).e, Math.max(1, Math.min(10, +count || 3)));
    return json(out, out.error ? 502 : 200);
  }
  if (path === "/api/shot" && req.method === "POST") {
    const u = safeHttp((await req.json().catch(() => ({}))).url);
    if (!u) return json({ error: "Read a page first." }, 400);
    const key = await shotKey(u), kept = await env.TAP.get(key, "json");
    if (kept) return json(kept);
    const capped = await underCap(env, acct, "shot");
    if (capped) return json({ error: capped }, 429);
    const out = await screenshot(env, u);
    if (!out.error) await env.TAP.put(key, JSON.stringify(out), { expirationTtl: SHOT_TTL });
    return json(out, out.error ? 502 : 200);
  }
  if (path === "/api/scroll" && req.method === "POST") {
    const { segments, elements, height, page, duration } = await req.json().catch(() => ({}));
    const segs = (Array.isArray(segments) ? segments : []).slice(0, 300).map(g => ({ s: +g.s || 0, e: +g.e || 0, t: String(g.t || "").slice(0, 400) })).filter(g => g.t);
    if (!segs.length) return json({ error: "Nothing was heard in your video. Say what the page does, out loud." }, 400);
    const els = (Array.isArray(elements) ? elements : []).slice(0, 150).map(e => ({ top: Math.max(0, Math.round(+e.top || 0)), text: String(e.text || "").slice(0, 120),
      left: Math.max(0, Math.round(+e.left || 0)), width: Math.max(0, Math.round(+e.width || 0)), height: Math.max(0, Math.round(+e.height || 0)) })).filter(e => e.text);
    const capped = await underCap(env, acct, "script");
    if (capped) return json({ error: capped }, 429);
    const out = await scrollPlan(env, segs, els, Math.max(SHOT_VIEW.height, Math.round(+height || 0)), page && typeof page === "object" ? page : {}, Math.max(1, Math.min(90, +duration || 90)));
    return json(out, out.error ? 502 : 200);
  }
  if (path === "/api/say" && req.method === "POST") {
    const { page, seconds } = await req.json().catch(() => ({}));
    if (!page?.text && !page?.description) return json({ error: "Read a page first." }, 400);
    const capped = await underCap(env, acct, "script");
    if (capped) return json({ error: capped }, 429);
    const out = await sayScript(env, page, Math.max(10, Math.min(90, Math.round(+seconds || 30))));
    return json(out, out.error ? 502 : 200);
  }
  if (path === "/api/voice" && req.method === "POST") {
    const { text, voice } = await req.json().catch(() => ({}));
    const line = String(text || "").trim().slice(0, 300);
    if (!line) return json({ error: "Nothing to read." }, 400);
    const capped = await underCap(env, acct, "voice");
    if (capped) return json({ error: capped }, 429);
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: VOICE_MODEL, voice: VOICES.has(voice) ? voice : "coral", input: line, response_format: "mp3",
        instructions: "A warm, upbeat narrator for a short social video. Natural pace, clear, never shouting." }),
    });
    if (!r.ok) return json({ error: `The voice service answered ${r.status}.` }, 502);
    return new Response(r.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  }
  if (path === "/api/img" && req.method === "GET") {
    const u = safeHttp(url.searchParams.get("u"));
    if (!u) return new Response("Bad image", { status: 400 });
    const r = await fetch(u.toString(), { headers: { "user-agent": "Mozilla/5.0 (compatible; TapBot/1.0)" }, cf: { cacheEverything: true, cacheTtl: 86400 } });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !type.startsWith("image/") || +(r.headers.get("content-length") || 0) > 10_000_000) return new Response("No image", { status: 502 });
    return new Response(r.body, { headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
  }
  if (path === "/api/upload" && req.method === "PUT") {
    if (!(req.headers.get("content-type") || "").startsWith("video/mp4")) return json({ error: "Only MP4." }, 415);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > VIDEO_MAX) return json({ error: "The video is over 25 MB." }, 413);
    if (buf.byteLength < 1000) return json({ error: "The video is empty." }, 400);
    const id = d.rand(12).replace(/[^A-Za-z0-9]/g, "").slice(0, 14);
    await env.TAP.put(`v:${id}`, buf, { expirationTtl: VIDEO_TTL, metadata: { acct } });
    user.videos = [...(user.videos || []).filter(v => v.until > Date.now()), { id, until: Date.now() + VIDEO_TTL * 1000 }];
    await d.putJSON(env, `user:${acct}`, user);
    return json({ id, url: `${url.origin}/v/${id}.mp4` });
  }
  if (path === "/api/like" && req.method === "GET") {
    const k = (user.kept || []).find(k => k.post === url.searchParams.get("id"));
    if (!k?.like) return json({ error: "That kept post isn't in your list any more." }, 404);
    return json({ title: k.title, ...k.like });
  }
  if (path === "/api/job" && req.method === "GET") {
    const job = await env.TAP.get(`job:${url.searchParams.get("id")}`, "json");
    if (!job || job.acct !== acct) return json({ error: "That review link has expired or belongs to another account." }, 404);
    return json({ page: job.page, videos: job.videos, note: job.note });
  }
  if (path === "/api/channels" && req.method === "GET") {
    if (!user.channels) ({ user } = await d.refreshPosts(env, acct, user));
    return json({ channels: (user.channels || []).filter(c => VIDEO_NETS.has(c.service) || url.searchParams.has("all")) });
  }
  if (path === "/api/plan" && req.method === "POST") {
    const { page, start, weeks, perWeek } = await req.json().catch(() => ({}));
    if (!page?.text && !page?.description && !page?.store) return json({ error: "Read a page first." }, 400);
    if (!user.channels) ({ user } = await d.refreshPosts(env, acct, user));
    const nets = [...new Set((user.channels || []).map(c => c.service))].filter(n => VIDEO_NETS.has(n) || TEXT_NETS.has(n));
    if (!nets.length) return json({ error: "Connect a channel in Buffer first." }, 400);
    const n = Math.max(2, Math.min(7, +perWeek || 3)), w = Math.max(1, Math.min(4, +weeks || 4));
    const first = /^\d{4}-\d{2}-\d{2}$/.test(start || "") ? new Date(start + "T12:00:00Z") : new Date(Date.now() + 86400000);
    const days = [[3], [1, 4], [0, 2, 4], [0, 1, 3, 4], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6]][n - 1];
    const dates = [];
    for (let k = 0; k < w; k++) for (const x of days) dates.push(new Date(first.getTime() + (k * 7 + x) * 86400000).toISOString().slice(0, 10));
    const capped = await underCap(env, acct, "script");
    if (capped) return json({ error: capped }, 429);
    const out = await writePlan(env, page, dates, nets);
    return json(out, out.error ? 502 : 200);
  }
  if (path === "/api/ideas" && req.method === "POST") {
    const { items } = await req.json().catch(() => ({}));
    const list = (Array.isArray(items) ? items : []).slice(0, 28);
    if (!list.length) return json({ error: "Tick at least one item." }, 400);
    const token = await d.accessToken(env, acct);
    if (!token) return json({ error: "Sign in with Buffer again." }, 401);
    const results = [];
    for (const it of list) {
      const services = [].concat(it.services || []).filter(s => VIDEO_NETS.has(s) || TEXT_NETS.has(s));
      const content = { title: String(it.angle || "").slice(0, 80), text: [it.hook, it.text || it.notes].filter(Boolean).map(String).join("\n\n").slice(0, 1000), aiAssisted: true, services };
      if (/^\d{4}-\d{2}-\d{2}$/.test(it.date || "")) content.date = `${it.date}T12:00:00.000Z`;
      const r = await d.gql(token, CREATE_IDEA, { i: { organizationId: user.orgId, content } });
      const x = r.data?.createIdea;
      results.push(x?.id ? { ok: true, date: it.date } : { ok: false, date: it.date, error: d.errText(r) || x?.message || `Buffer answered ${r.status}.` });
    }
    return json({ results });
  }
  if (path === "/api/draft" && req.method === "POST") {
    const { video, channels, caption, title, hashtags, angle, hook, lines, link, poster } = await req.json().catch(() => ({}));
    const kept = (user.videos || []).find(v => v.id === video);
    if (!kept) return json({ error: "Upload the video first." }, 400);
    const chosen = (user.channels || []).filter(c => (channels || []).includes(c.id));
    if (!chosen.length) return json({ error: "Pick at least one channel." }, 400);
    const token = await d.accessToken(env, acct);
    if (!token) return json({ error: "Buffer access has lapsed. Sign in again." }, 401);
    // One Buffer tag per video, so its posts can be found together later (Keep this).
    if (!kept.tagId && angle) {
      const t = await d.gql(token, CREATE_TAG, { i: { organizationId: user.orgId, tag: { name: `Dailies: ${String(angle)}`.slice(0, 40), color: "#e8b830" } } });
      if ((kept.tagId = t.data?.createTag?.tag?.id || "")) await d.putJSON(env, `user:${acct}`, user);
    }
    const results = [];
    for (const ch of chosen) {
      const text = captionFor(ch.service, String(caption || "").slice(0, 2000), hashtags);
      const r = await d.gql(token, CREATE_POST, { i: postInput(ch, { text, video: `${url.origin}/v/${video}.mp4`, title, tagIds: kept.tagId ? [kept.tagId] : [] }) });
      const id = r.data?.createPost?.post?.id;
      results.push({ channel: ch.service, ok: !!id, error: id ? "" : (d.errText(r) || r.data?.createPost?.message || r.data?.createPost?.__typename || `HTTP ${r.status}`) });
    }
    // Remember what was made (outlasting the video file), so a winner can be kept and made again.
    if (kept.tagId && results.some(x => x.ok)) {
      const str = (x, n) => String(x || "").slice(0, n);
      const rec = (user.made || []).find(m => m.tagId === kept.tagId) || { tagId: kept.tagId, at: new Date().toISOString() };
      Object.assign(rec, { angle: str(angle, 80), title: str(title, 100), caption: str(caption, 500), hook: str(hook, 140),
        lines: [].concat(lines || []).slice(0, 8).map(l => str(l, 120)), link: safeHttp(link || "")?.href || "" });
      // A small still for its row on /me: a JPEG data URL from the browser, up to 80 KB.
      const jpeg = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]{100,110000})$/.exec(String(poster || ""))?.[1];
      if (jpeg) {
        const bytes = Uint8Array.from(atob(jpeg), c => c.charCodeAt(0));
        if (bytes[0] === 0xff && bytes[1] === 0xd8) { await env.TAP.put(`pf:${acct}:${rec.tagId}`, bytes); rec.poster = true; }
      }
      const all = [rec, ...(user.made || []).filter(m => m !== rec)];
      await Promise.all(all.slice(100).filter(m => m.poster).map(m => env.TAP.delete(`pf:${acct}:${m.tagId}`)));
      user.made = all.slice(0, 100);
      await d.putJSON(env, `user:${acct}`, user);
    }
    return json({ results });
  }
  return json({ error: "Not found" }, 404);
}
