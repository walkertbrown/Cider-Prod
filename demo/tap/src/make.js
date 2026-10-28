// Link to Shorts: read a page, write scripts, host the videos the browser
// renders, and draft them into Buffer.
//   POST /api/read     {urls} (1–5) → the pages' titles, text, images, and a suggested count
//   POST /api/scripts  {page, count} → video scripts (language model, capped)
//   POST /api/voice    {text, voice} → MP3 of one line read aloud (text-to-speech, capped)
//   GET  /api/img?u=   an image from the page, re-served so the canvas can encode it
//   PUT  /api/upload   an MP4 from the browser → {id, url}
//   GET  /api/channels the account's Buffer channels
//   POST /api/draft    {video, channels, caption, title} → one Buffer draft per channel
//   GET  /v/<id>.mp4   the hosted video, public, for Buffer to fetch (with ranges)

const SCRIPT_MODEL = "gpt-5.4-mini";
const CAPS = { script: [20, 200], voice: [150, 1500] }; // a day: per account, overall
const VOICE_MODEL = "gpt-4o-mini-tts";
const VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]);
const VIDEO_TTL = 30 * 86400, VIDEO_MAX = 25 * 1024 * 1024;
const VIDEO_NETS = new Set(["instagram", "tiktok", "youtube", "facebook", "linkedin", "twitter", "threads", "bluesky", "mastodon", "pinterest"]);

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const today = () => new Date().toISOString().slice(0, 10);
const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
  .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const strip = s => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function safeHttp(s) {
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
- caption: the post text for the networks, 1 to 3 short sentences plus the site address, at most 300 characters. title: at most 90 characters, for YouTube.
Return JSON only: {"note": string, "videos": [{"angle": string, "title": string, "caption": string, "scenes": [{"text": string, "image": integer or null, "seconds": number}]}]}`;

async function writeScripts(env, page, count) {
  const input = `Host: ${page.host}\nURL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description}\n` +
    (page.products?.length ? `Products: ${JSON.stringify(page.products)}\n` : "") +
    `Images (index: url): ${page.images.map((u, i) => `${i}: ${u.split("/").pop().slice(0, 60)}`).join("; ") || "none"}\n\nPage text:\n${String(page.text || "").slice(0, 14000)}\n\nWrite ${count} video${count === 1 ? "" : "s"}.`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: SCRIPT_MODEL, response_format: { type: "json_object" }, reasoning_effort: "low",
      messages: [{ role: "system", content: SCRIPT_RULES }, { role: "user", content: input }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error?.message || `The script writer answered ${r.status}.` };
  let out; try { out = JSON.parse(d.choices[0].message.content); } catch { return { error: "The script writer returned something unreadable. Try again." }; }
  const n = page.images.length;
  out.videos = (out.videos || []).slice(0, 10).map(v => ({
    angle: String(v.angle || ""), title: String(v.title || "").slice(0, 100), caption: String(v.caption || "").slice(0, 500),
    scenes: (v.scenes || []).slice(0, 8).map(s => ({ text: String(s.text || "").slice(0, 120), image: Number.isInteger(s.image) && s.image >= 0 && s.image < n ? s.image : null, seconds: Math.min(6, Math.max(2, +s.seconds || 3)) })),
  })).filter(v => v.scenes.length);
  return out;
}

// One daily counter per account and one overall, in KV (approximate under races; fine as a cap).
async function underCap(env, acct, kind) {
  const [perAcct, overall] = CAPS[kind], tag = kind === "script" ? "" : kind + ":";
  const kA = `cap:${tag}${today()}:${acct}`, kAll = `cap:${tag}${today()}:all`;
  const [a, all] = await Promise.all([env.TAP.get(kA), env.TAP.get(kAll)]);
  if (+a >= perAcct) return `You've used today's ${perAcct} ${kind === "script" ? "script runs" : "voiceover lines"}. More tomorrow.`;
  if (+all >= overall) return "Tap has reached today's limit for everyone. More tomorrow.";
  await Promise.all([env.TAP.put(kA, String(+a + 1), { expirationTtl: 2 * 86400 }), env.TAP.put(kAll, String(+all + 1), { expirationTtl: 2 * 86400 })]);
  return "";
}

// ---- Drafting --------------------------------------------------------------

export function postInput(ch, { text, video, title, category, tagIds = [] }) {
  const i = { channelId: ch.id, text, mode: "addToQueue", schedulingType: "automatic", saveToDraft: true, tagIds,
    assets: video ? [{ video: { url: video } }] : [] };
  const t = (title || text.split("\n")[0]).slice(0, 100);
  if (ch.service === "instagram") i.metadata = { instagram: { type: video ? "reel" : "post", shouldShareToFeed: true } };
  if (ch.service === "youtube") i.metadata = { youtube: { title: t, categoryId: category || "22" } };
  if (ch.service === "tiktok") i.metadata = { tiktok: { title: t } };
  return i;
}

const CREATE_POST = `mutation($i:CreatePostInput!){ createPost(input:$i){ __typename ... on PostActionSuccess { post { id } }
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
    try { const page = await readPages(urls); return json(page, page.error ? 422 : 200); }
    catch (e) { return json({ error: `Couldn't read the page: ${e.message}` }, 422); }
  }
  if (path === "/api/scripts" && req.method === "POST") {
    const { page, count } = await req.json().catch(() => ({}));
    if (!page?.text && !page?.description) return json({ error: "Read a page first." }, 400);
    const capped = await underCap(env, acct, "script");
    if (capped) return json({ error: capped }, 429);
    const out = await writeScripts(env, page, Math.max(1, Math.min(10, +count || 1)));
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
  if (path === "/api/channels" && req.method === "GET") {
    if (!user.channels) ({ user } = await d.refreshPosts(env, acct, user));
    return json({ channels: (user.channels || []).filter(c => VIDEO_NETS.has(c.service)) });
  }
  if (path === "/api/draft" && req.method === "POST") {
    const { video, channels, caption, title } = await req.json().catch(() => ({}));
    if (!(user.videos || []).some(v => v.id === video)) return json({ error: "Upload the video first." }, 400);
    const chosen = (user.channels || []).filter(c => (channels || []).includes(c.id));
    if (!chosen.length) return json({ error: "Pick at least one channel." }, 400);
    const token = await d.accessToken(env, acct);
    if (!token) return json({ error: "Buffer access has lapsed. Sign in again." }, 401);
    const results = [];
    for (const ch of chosen) {
      const r = await d.gql(token, CREATE_POST, { i: postInput(ch, { text: String(caption || "").slice(0, 2000), video: `${url.origin}/v/${video}.mp4`, title }) });
      const id = r.data?.createPost?.post?.id;
      results.push({ channel: ch.service, ok: !!id, error: id ? "" : (d.errText(r) || r.data?.createPost?.message || r.data?.createPost?.__typename || `HTTP ${r.status}`) });
    }
    return json({ results });
  }
  return json({ error: "Not found" }, 404);
}
