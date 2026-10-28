// Tap: which of your Buffer posts sent people. Buffer Commit, 28 Oct – 13 Nov.
//   GET  /auth/start      redirect to Buffer's consent screen
//   GET  /auth/callback   exchange the code, keep the tokens, sign the owner in
//   GET  /me              the owner's page: each post, its taps, its destination
//   POST /me              save destinations
//   POST /me/keep         Keep this: a Buffer template and tag from a post
//   POST /me/again        Post it again: tagged drafts in Buffer, never sent
//   POST /me/forget       drop a kept post, and its template and tag
//   POST /me/disconnect   delete everything Tap keeps for the account
//   GET  /u/<name>        the public bio page: one tile per post
//   GET  /p/<name>/<post> count a tap, then send the visitor on
//   GET  /go/<name>       the bio page's skip link, counted the same way
//   GET  /t/<name>/<post> the post's thumbnail, fetched from Buffer and cached here
//   /make, /api/*, /v/<id>.mp4  Link to Shorts (src/make.js)
//   POST /me/key          make a Claude key (shown once) for /mcp
//   POST /mcp             the Claude Code MCP server (src/mcp.js) · GET /i/<id> its screenshots
// KV: tok:<acct> tokens · user:<acct> posts and settings · name:<name> → acct
//     ses:<sid> → acct · n:<acct>:<post> {p, f} counts. Visitors get no cookie.
//     v:<id> a rendered MP4 (30 days) · cap:<day>:<acct|all> script runs
//     key:<sha256> → acct · job:<id> scripts from Claude Code (7 days) · img:<id> a screenshot (7 days)

import { api, serveVideo } from "./make.js";
import { mcp, sha256 } from "./mcp.js";

const HOME = "https://tap.bananafest-destiny.com";
const REDIRECT = HOME + "/auth/callback";
const SCOPE = "account:read posts:read posts:write ideas:read ideas:write offline_access";
const API = "https://api.buffer.com";
const POSTS_TTL = 6 * 3600 * 1000;
const SES_TTL = 30 * 86400;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const shortId = id => id.slice(-8);

const CSS = `:root{--bg:#fbf8f1;--fg:#1d1b16;--muted:#5f5a4f;--line:#e2dccd;--card:#fff;--gold:#b8860b}
@media (prefers-color-scheme:dark){:root{--bg:#15140f;--fg:#efeadc;--muted:#a59f8f;--line:#2e2b22;--card:#1e1c16;--gold:#e8b830}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}a{color:inherit}h1{line-height:1.15}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px 4px;vertical-align:top;text-align:left;overflow-wrap:anywhere}
.n{font-variant-numeric:tabular-nums;font-size:22px;font-weight:600}.note{font-size:14px;color:var(--muted)}
input[type=url],input[type=text]{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);font:inherit;font-size:14px}
button,.btn{display:inline-block;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer;text-decoration:none}
.primary{background:var(--gold);border-color:var(--gold);color:#15140f;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.tile{display:block;text-decoration:none;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.tile img{display:block;width:100%;aspect-ratio:9/16;object-fit:cover;background:var(--line)}
.tile span{display:block;padding:8px;font-size:14px;line-height:1.35}.tile small{color:var(--muted)}
th.num,td.num{width:4.5em;white-space:nowrap}
.small{padding:3px 8px;font-size:13px;margin-top:6px}.flash{background:var(--card);border-left:4px solid var(--gold);padding:8px 12px}
.kept{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0}.kept form{display:inline}
.thumb{width:48px;aspect-ratio:9/16;object-fit:cover;border-radius:4px;background:var(--line)}`;

function page(title, body, { status = 200, headers = {}, index = false } = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${index ? "" : '<meta name="robots" content="noindex">'}
<title>${esc(title)}</title><link rel="icon" href="/logo.png">
<script src="https://pulse.bananafest-destiny.com/p.js" data-site="tap.bananafest-destiny.com" defer></script>
<style>${CSS}</style></head>
<body><main>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
}

async function gql(token, query, variables) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  let body; try { body = await r.json(); } catch { body = { errors: [{ message: `HTTP ${r.status}` }] }; }
  return { status: r.status, ...body };
}
const errText = res => (res.errors || []).map(e => e.message + (e.extensions?.code ? ` (${e.extensions.code})` : "")).join("; ");

const getJSON = async (env, k) => { const v = await env.TAP.get(k); return v ? JSON.parse(v) : null; };
const putJSON = (env, k, v, opts) => env.TAP.put(k, JSON.stringify(v), opts);

// ---- Tokens ----------------------------------------------------------------

async function tokenRequest(env, params) {
  const r = await fetch("https://auth.buffer.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.BUFFER_CLIENT_ID, client_secret: env.BUFFER_CLIENT_SECRET, ...params }),
  });
  const tok = await r.json().catch(() => ({}));
  return r.ok && tok.access_token ? tok : { error: tok.error || String(r.status), error_description: tok.error_description || "" };
}

const keepTokens = (env, acct, tok, prev = {}) => putJSON(env, `tok:${acct}`, {
  access_token: tok.access_token, refresh_token: tok.refresh_token || prev.refresh_token || null,
  expires_at: Date.now() + (tok.expires_in || 3600) * 1000, scope: tok.scope || prev.scope || "", at: new Date().toISOString(),
});

// Refresh tokens are single-use, so the new one is kept before anything else.
async function accessToken(env, acct) {
  const t = await getJSON(env, `tok:${acct}`);
  if (!t) return null;
  if (t.expires_at > Date.now() + 60_000) return t.access_token;
  if (!t.refresh_token) return null;
  const tok = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: t.refresh_token });
  if (tok.error) return null;
  await keepTokens(env, acct, tok, t);
  return tok.access_token;
}

// ---- Posts -----------------------------------------------------------------

// The first web address in the post's text, which is where the boss's posts
// name their site ("puzzlepress.bananafest-destiny.com — built in public").
function linkIn(text) {
  const m = String(text || "").match(/\b(https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s)]*)?/i);
  return m ? m[0].replace(/[.,;:!?'"]+$/, "") : "";
}
const firstLink = text => { const l = linkIn(text); return l && (/^https?:/i.test(l) ? l : "https://" + l); };

function postTitle(n) {
  const t = n.metadata?.title || String(n.text || "").split("\n").find(l => l.trim()) || "";
  return t.length > 90 ? t.slice(0, 88).trimEnd() + "…" : t;
}

const POSTS_Q = `query($o:OrganizationId!){ posts(first:50, input:{organizationId:$o, filter:{status:[sent]}}){
  edges { node { id channelId channelService sentAt text externalLink tags { id }
    assets { __typename thumbnail source }
    metadata { __typename ... on YoutubePostMetadata { title category { categoryId } } ... on TiktokPostMetadata { title } } } } }
  channels(input:{organizationId:$o}){ id service } }`;

async function refreshPosts(env, acct, user) {
  const token = await accessToken(env, acct);
  if (!token) return { user, error: "Buffer access has lapsed. Sign in again." };
  const res = await gql(token, POSTS_Q, { o: user.orgId });
  if (!res.data) return { user, error: errText(res) || `Buffer answered ${res.status}` };
  user.posts = res.data.posts.edges.map(({ node: n }) => ({
    id: n.id, service: n.channelService, sentAt: n.sentAt, title: postTitle(n),
    thumb: n.assets?.find(a => a.thumbnail)?.thumbnail || "", link: n.externalLink || "", found: firstLink(n.text),
    channelId: n.channelId, text: n.text, tagIds: n.tags.map(t => t.id), ytTitle: n.metadata?.title || "",
    ytCategory: n.metadata?.category?.categoryId || "",
    media: n.assets.filter(a => a.source).map(a => ({ kind: a.__typename === "VideoAsset" ? "video" : a.__typename === "ImageAsset" ? "image" : "", url: a.source })).filter(a => a.kind),
  }));
  user.channels = res.data.channels;
  user.postsAt = Date.now();
  await putJSON(env, `user:${acct}`, user);
  return { user };
}

const destFor = (user, p) => user.dest?.[p.id] || p.found || user.mainDest || "";

// ---- Sign-in ---------------------------------------------------------------

async function start(env) {
  const state = rand(), verifier = rand();
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await env.TAP.put(`st:${state}`, verifier, { expirationTtl: 600 });
  const u = new URL("https://auth.buffer.com/auth");
  for (const [k, v] of Object.entries({
    client_id: env.BUFFER_CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE,
    state, code_challenge: challenge, code_challenge_method: "S256", prompt: "consent",
  })) u.searchParams.set(k, v);
  return Response.redirect(u.toString(), 302);
}

async function callback(url, env) {
  const { searchParams: q } = url;
  if (q.get("error")) return page("Not connected", `<h1>Not connected</h1><p>Buffer said: ${esc(q.get("error"))}. Nothing was kept.</p><p><a href="/auth/start">Try again</a></p>`, { status: 403 });
  const state = q.get("state") || "", code = q.get("code") || "";
  const verifier = state && await env.TAP.get(`st:${state}`);
  if (!verifier || !code) return page("That sign-in link has expired", `<h1>That sign-in link has expired</h1><p><a href="/auth/start">Start again</a></p>`, { status: 400 });
  await env.TAP.delete(`st:${state}`);

  const tok = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
  if (tok.error) return page("Buffer didn't hand over access", `<h1>Buffer didn't hand over access</h1><p>${esc(tok.error)}: ${esc(tok.error_description)}</p>`, { status: 502 });

  const acc = await gql(tok.access_token, "{ account { id organizations { id name } } }");
  const acct = acc.data?.account?.id, org = acc.data?.account?.organizations?.[0];
  if (!acct || !org) return page("No Buffer organization", `<h1>No Buffer organization</h1><p>${esc(errText(acc) || "This account has no organization to read posts from.")}</p>`, { status: 502 });
  await keepTokens(env, acct, tok);

  let user = await getJSON(env, `user:${acct}`);
  if (!user) {
    let name; do name = rand(4).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6); while (name.length < 4 || await env.TAP.get(`name:${name}`));
    user = { name, orgId: org.id, dest: {}, mainDest: "", posts: [], postsAt: 0, sessions: [] };
    await env.TAP.put(`name:${name}`, acct);
  }
  user.orgId = org.id;
  const sid = rand();
  user.sessions = [...(user.sessions || []).slice(-4), sid];
  await putJSON(env, `user:${acct}`, user);
  await env.TAP.put(`ses:${sid}`, acct, { expirationTtl: SES_TTL });
  return new Response(null, { status: 303, headers: {
    location: "/me",
    "set-cookie": `tap_sid=${sid}; Path=/; Max-Age=${SES_TTL}; HttpOnly; Secure; SameSite=Lax`,
  } });
}

async function owner(req, env) {
  const sid = (req.headers.get("cookie") || "").match(/(?:^|;\s*)tap_sid=([\w-]+)/)?.[1];
  const acct = sid && await env.TAP.get(`ses:${sid}`);
  const user = acct && await getJSON(env, `user:${acct}`);
  return user ? { acct, user, sid } : null;
}

// ---- Counting --------------------------------------------------------------

// A person is a browser navigating to a page; everything else is a fetcher
// (link previews, checkers, crawlers). No IP or cookie is read or kept.
function isPerson(req) {
  const h = k => req.headers.get(k) || "";
  return (h("sec-fetch-mode") === "navigate" || h("sec-fetch-dest") === "document")
    && h("accept").includes("text/html") && !!h("accept-language");
}

async function count(env, acct, key, req) {
  const k = `n:${acct}:${key}`;
  const c = await getJSON(env, k) || { p: 0, f: 0 };
  isPerson(req) ? c.p++ : c.f++;
  await putJSON(env, k, c);
}

async function counts(env, acct) {
  const out = {};
  let cursor;
  do {
    const l = await env.TAP.list({ prefix: `n:${acct}:`, cursor });
    await Promise.all(l.keys.map(async k => { out[k.name.slice(`n:${acct}:`.length)] = await getJSON(env, k.name); }));
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out;
}

async function tap(env, ctx, req, name, sid) {
  const acct = await env.TAP.get(`name:${name}`);
  const user = acct && await getJSON(env, `user:${acct}`);
  if (!user) return new Response("Not found", { status: 404 });
  let to, key;
  if (sid === null) { to = user.mainDest || user.posts.map(p => destFor(user, p)).find(Boolean); key = "skip"; }
  else {
    const p = user.posts.find(p => shortId(p.id) === sid);
    if (!p) return Response.redirect(`${HOME}/u/${name}`, 302);
    to = destFor(user, p); key = p.id;
  }
  ctx.waitUntil(count(env, acct, key, req));
  return new Response(null, { status: 302, headers: { location: to || `${HOME}/u/${name}`, "cache-control": "no-store", "referrer-policy": "no-referrer-when-downgrade" } });
}

// Visitors' browsers never fetch from Buffer: Tap fetches each thumbnail once
// and Cloudflare keeps it for a day.
async function thumb(env, name, sid) {
  const acct = await env.TAP.get(`name:${name}`);
  const user = acct && await getJSON(env, `user:${acct}`);
  const p = user?.posts.find(p => shortId(p.id) === sid);
  if (!p?.thumb?.startsWith("https://")) return new Response("Not found", { status: 404 });
  const r = await fetch(p.thumb, { cf: { cacheEverything: true, cacheTtl: 86400 } });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("image/")) return new Response("No thumbnail", { status: 502 });
  return new Response(r.body, { headers: { "content-type": type, "cache-control": "public, max-age=86400" } });
}

// ---- Pages -----------------------------------------------------------------

const NET = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", twitter: "X", threads: "Threads", bluesky: "Bluesky", mastodon: "Mastodon", pinterest: "Pinterest" };
const net = s => NET[s] || s;
const day = iso => iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";

function bioPage(user) {
  const tiles = user.posts.map(p => `<a class="tile" href="/p/${user.name}/${shortId(p.id)}">
${p.thumb ? `<img src="/t/${user.name}/${shortId(p.id)}" alt="" loading="lazy">` : ""}<span>${esc(p.title)}<br><small>${esc(net(p.service))} · ${esc(day(p.sentAt))}</small></span></a>`).join("");
  return page("Which post brought you here?", `
<h1>Which post brought you here?</h1>
<p>Tap the one you saw. <a href="/go/${user.name}">Or skip straight to the site</a>.</p>
<div class="grid">${tiles || '<p class="note">No posts yet.</p>'}</div>
<p class="note" style="margin-top:32px">Made with <a href="/">Tap</a>. Tapping counts one visit for that post: a number, with no cookie and no IP kept.</p>`);
}

async function mePage(env, ctx, req, { acct, user }) {
  let error = "";
  if (Date.now() - (user.postsAt || 0) > POSTS_TTL || new URL(req.url).searchParams.has("refresh")) ({ user, error } = await refreshPosts(env, acct, user));
  const c = await counts(env, acct);
  const total = Object.values(c).reduce((s, x) => s + (x?.p || 0), 0);
  const bio = `${HOME}/u/${user.name}`;
  const kept = new Set((user.kept || []).map(k => k.post));
  const rows = user.posts.map(p => {
    const n = c[p.id] || { p: 0, f: 0 };
    return `<tr><td>${p.thumb ? `<img class="thumb" src="/t/${user.name}/${shortId(p.id)}" alt="" loading="lazy">` : ""}</td>
<td>${p.link ? `<a href="${esc(p.link)}">${esc(p.title)}</a>` : esc(p.title)}<br><span class="note">${esc(net(p.service))} · ${esc(day(p.sentAt))}</span>
<input type="url" name="d_${esc(p.id)}" value="${esc(user.dest?.[p.id] || "")}" placeholder="${esc(p.found || user.mainDest || "Where should this post send people?")}" aria-label="Destination"></td>
<td class="num"><span class="n">${n.p}</span><br><span class="note">${n.f ? `+${n.f} fetcher${n.f === 1 ? "" : "s"}` : ""}</span><br>
${kept.has(p.id) ? '<span class="note">Kept</span>' : `<button class="small" formaction="/me/keep" name="post" value="${esc(p.id)}">Keep this</button>`}</td></tr>`;
  }).join("");
  const skip = c.skip || { p: 0, f: 0 };
  const flash = user.flash;
  if (flash) { delete user.flash; ctx.waitUntil(putJSON(env, `user:${acct}`, user)); }
  return page("Your posts", `
<a href="/">Tap</a>
<h1>Your posts</h1>
<p><a class="primary" href="/make/" style="display:inline-block;padding:8px 16px;border-radius:8px;text-decoration:none;font-weight:600">Make shorts from a link</a></p>
${error ? `<p class="note" style="color:#c0392b">Couldn't refresh from Buffer: ${esc(error)} ${error.includes("Sign in") ? '<a href="/auth/start">Sign in</a>' : ""}</p>` : ""}
<p>Your bio link: <a href="${bio}"><b>${bio}</b></a><br><span class="note">Put it in your Instagram, TikTok or YouTube bio. Visitors pick the post they saw, and Tap counts it before sending them on.</span></p>
${flash ? `<p class="flash">${esc(flash)}</p>` : ""}
<p><span class="n">${total}</span> ${total === 1 ? "person" : "people"} so far${total ? "" : ". Nothing is counted until someone taps your bio link"}. ${skip.p} of them skipped straight to the site.</p>
${keptSection(user, c)}
<form method="post" action="/me">
<h2>Posts</h2>
<p><label>Main site (for the skip link, and posts with no address of their own)<br>
<input type="url" name="main" value="${esc(user.mainDest || "")}" placeholder="https://"></label></p>
<table><tr><th></th><th>Post, and where it sends people</th><th class="num">People</th></tr>${rows || '<tr><td></td><td class="note">No sent posts in Buffer yet.</td><td></td></tr>'}</table>
<p><button class="primary">Save</button> <a class="btn" href="/me?refresh">Refresh from Buffer</a></p>
</form>
<p class="note">A person is counted when a browser opens the link as a page. Link previews, checkers and crawlers are counted apart as fetchers. Posts were read from Buffer ${user.postsAt ? new Date(user.postsAt).toUTCString().slice(5, 22) + " UTC" : "not yet"}. Buffer doesn't let outside apps read post views or clicks yet, so this page shows only what Tap counts itself.</p>
<h2>Claude Code</h2>
<p class="note">Let Claude Code make videos of what you build: it sends what shipped, Tap writes the scripts, and you get a link here to render and draft them. Nothing posts without you.${user.mcpKey ? ` Your key was made ${esc(day(user.mcpKey.at))} and ends in ${esc(user.mcpKey.tail)}.` : ""}</p>
<form method="post" action="/me/key"${user.mcpKey ? ` onsubmit="return confirm('Make a new key? The old one stops working.')"` : ""}><button>${user.mcpKey ? "Make a new Claude key" : "Make a Claude key"}</button></form>
<form method="post" action="/me/disconnect" onsubmit="return confirm('Delete everything Tap keeps for this account?')"><button>Disconnect and delete</button></form>`);
}

// ---- Keep this / Post it again ----------------------------------------------

// A kept post's record: the original, plus every post carrying its tag,
// whether Tap drafted it or the owner tagged it by hand in Buffer.
function keptStats(user, k, c) {
  const posts = user.posts.filter(p => p.id === k.post || p.tagIds?.includes(k.tagId));
  const by = {};
  for (const p of posts) by[p.service] = (by[p.service] || 0) + (c[p.id]?.p || 0);
  const people = Object.values(by).reduce((a, b) => a + b, 0);
  const best = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  return { posts, people, best: best && best[1] > 0 ? best[0] : "" };
}

function untried(user, k, posts) {
  const ran = new Set([...posts.map(p => p.channelId), ...(k.drafts || []).map(d => d.channelId)]);
  return (user.channels || []).filter(ch => !ran.has(ch.id));
}

function keptSection(user, c) {
  const list = (user.kept || []).map(k => ({ k, ...keptStats(user, k, c) })).sort((a, b) => b.people - a.people);
  if (!list.length) return `<h2>Kept</h2><p class="note">Press "Keep this" on a post that worked. Tap saves it as a template and a tag in your Buffer, then can draft it again for your other networks.</p>`;
  return `<h2>Kept</h2>` + list.map(({ k, posts, people, best }) => {
    const left = untried(user, k, posts);
    return `<div class="kept"><b>${esc(k.title)}</b><br>
<span class="note">${posts.length} post${posts.length === 1 ? "" : "s"} · <b>${people}</b> ${people === 1 ? "person" : "people"}${best ? ` · best on ${esc(net(best))}` : ""} · template and tag "${esc(k.tagName)}" in Buffer${k.drafts?.length ? ` · drafted for ${esc(k.drafts.map(d => net(d.service)).join(", "))}` : ""}</span><br>
${left.length ? `<form method="post" action="/me/again"><button class="small primary" name="kept" value="${esc(k.post)}">Post it again: draft for ${esc(left.map(ch => net(ch.service)).join(", "))}</button></form> ` : ""}
<form method="post" action="/me/forget" onsubmit="return confirm('Forget this, and delete its template and tag in Buffer?')"><button class="small" name="kept" value="${esc(k.post)}">Forget</button></form></div>`;
  }).join("");
}

const done = async (env, acct, user, flash) => {
  if (flash) user.flash = flash;
  await putJSON(env, `user:${acct}`, user);
  return new Response(null, { status: 303, headers: { location: "/me" } });
};
const failText = (res, key) => errText(res) || res.data?.[key]?.message || res.data?.[key]?.__typename || `HTTP ${res.status}`;

async function keep(req, env, { acct, user }) {
  const id = (await req.formData()).get("post");
  const p = user.posts.find(p => p.id === id);
  if (!p) return done(env, acct, user, "That post isn't in Tap's copy any more. Refresh from Buffer and try again.");
  if ((user.kept || []).some(k => k.post === id)) return done(env, acct, user, "Already kept.");
  const token = await accessToken(env, acct);
  if (!token) return done(env, acct, user, "Buffer access has lapsed. Sign in again.");
  const people = (await getJSON(env, `n:${acct}:${p.id}`))?.p || 0;
  const title = `${net(p.service)}, ${people} ${people === 1 ? "person" : "people"}, ${day(p.sentAt)}`;
  const link = linkIn(p.text);
  const body = link ? p.text.split(link).join("{{link}}") : p.text;
  const t = await gql(token, `mutation($i:CreatePostTemplateInput!){ createPostTemplate(input:$i){
    __typename ... on CreatePostTemplateSuccess { postTemplate { id } } ... on VoidMutationError { message } } }`,
    { i: { organizationId: user.orgId, title, description: p.title.slice(0, 200), body, emoji: "🎯", visibility: "private" } });
  const templateId = t.data?.createPostTemplate?.postTemplate?.id;
  if (!templateId) return done(env, acct, user, `Buffer didn't make the template: ${failText(t, "createPostTemplate")}`);
  const words = p.title.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).slice(0, 4).join(" ").slice(0, 30);
  let tag, tagName;
  for (const suffix of ["", ` ${shortId(p.id).slice(-4)}`]) {
    tagName = `Tap: ${words}${suffix}`;
    tag = await gql(token, `mutation($o:OrganizationId!,$n:String!){ createTag(input:{organizationId:$o, tag:{name:$n, color:"#e8b830"}}){
      __typename ... on TagActionSuccess { tag { id } } ... on InvalidInputError { message } ... on DuplicateError { message } ... on UnauthorizedError { message } ... on UnexpectedError { message } } }`, { o: user.orgId, n: tagName });
    if (tag.data?.createTag?.__typename !== "DuplicateError") break;
  }
  const tagId = tag.data?.createTag?.tag?.id;
  if (!tagId) {
    await gql(token, "mutation($i:PostTemplateId!){ deletePostTemplate(input:{id:$i}){ __typename } }", { i: templateId });
    return done(env, acct, user, `Buffer didn't make the tag: ${failText(tag, "createTag")}`);
  }
  (user.kept ||= []).push({ post: p.id, templateId, tagId, tagName, title, at: new Date().toISOString(), drafts: [] });
  return done(env, acct, user, `Kept. Buffer now has a template "${title}" and a tag "${tagName}".`);
}

// One draft per channel the post hasn't run on, with each network's required fields.
function draftInput(p, k, ch) {
  const video = p.media.find(m => m.kind === "video");
  const i = { channelId: ch.id, text: p.text, mode: "addToQueue", schedulingType: "automatic", saveToDraft: true,
    tagIds: [k.tagId], assets: p.media.map(m => ({ [m.kind]: { url: m.url } })) };
  const title = (p.ytTitle || p.title).slice(0, 100);
  if (ch.service === "instagram") i.metadata = { instagram: { type: video ? "reel" : p.media.length > 1 ? "carousel" : "post", shouldShareToFeed: true } };
  if (ch.service === "youtube") i.metadata = { youtube: { title, categoryId: p.ytCategory || "22" } };
  if (ch.service === "tiktok") i.metadata = { tiktok: { title } };
  if (["youtube", "tiktok"].includes(ch.service) && !video) return null;
  return i;
}

async function again(req, env, { acct, user }) {
  const id = (await req.formData()).get("kept");
  const k = (user.kept || []).find(k => k.post === id);
  const p = k && user.posts.find(p => p.id === k.post);
  if (!p) return done(env, acct, user, "That kept post isn't in Tap's copy any more.");
  const token = await accessToken(env, acct);
  if (!token) return done(env, acct, user, "Buffer access has lapsed. Sign in again.");
  const c = await counts(env, acct);
  const made = [], failed = [];
  for (const ch of untried(user, k, keptStats(user, k, c).posts)) {
    const input = draftInput(p, k, ch);
    if (!input) { failed.push(`${net(ch.service)} (needs a video)`); continue; }
    const r = await gql(token, `mutation($i:CreatePostInput!){ createPost(input:$i){ __typename ... on PostActionSuccess { post { id } }
      ... on InvalidInputError { message } ... on LimitReachedError { message } ... on UnauthorizedError { message } ... on UnexpectedError { message } ... on RestProxyError { message } ... on NotFoundError { message } } }`, { i: input });
    const id = r.data?.createPost?.post?.id;
    if (id) { k.drafts.push({ channelId: ch.id, service: ch.service, id }); made.push(net(ch.service)); }
    else failed.push(`${net(ch.service)} (${failText(r, "createPost")})`);
  }
  return done(env, acct, user, [
    made.length ? `Drafts made in Buffer for ${made.join(", ")}, tagged "${k.tagName}". Check them and send them from Buffer; Tap never sends.` : "",
    failed.length ? `Not drafted: ${failed.join("; ")}.` : "",
  ].filter(Boolean).join(" ") || "Nothing left to draft.");
}

async function forget(req, env, { acct, user }) {
  const id = (await req.formData()).get("kept");
  const k = (user.kept || []).find(k => k.post === id);
  if (!k) return done(env, acct, user, "");
  const token = await accessToken(env, acct);
  if (token) await Promise.all([
    gql(token, "mutation($i:PostTemplateId!){ deletePostTemplate(input:{id:$i}){ __typename } }", { i: k.templateId }),
    gql(token, "mutation($i:TagId!){ deleteTag(input:{id:$i}){ __typename } }", { i: k.tagId }),
  ]);
  user.kept = user.kept.filter(x => x !== k);
  return done(env, acct, user, token ? `Forgot "${k.title}", and deleted its template and tag in Buffer.` : `Forgot "${k.title}". Buffer access has lapsed, so its template and tag are still in Buffer.`);
}

const safeUrl = s => { try { const u = new URL(s.trim()); return /^https?:$/.test(u.protocol) ? u.toString() : ""; } catch { return ""; } };

async function save(req, env, { acct, user }) {
  const f = await req.formData();
  user.mainDest = safeUrl(f.get("main") || "");
  user.dest = {};
  for (const p of user.posts) { const d = safeUrl(f.get(`d_${p.id}`) || ""); if (d) user.dest[p.id] = d; }
  await putJSON(env, `user:${acct}`, user);
  return new Response(null, { status: 303, headers: { location: "/me" } });
}

// A Claude key: shown once; only its hash is kept. A new key replaces the old one.
async function makeKey(req, env, { acct, user }) {
  const key = `tap_${rand(24)}`;
  if (user.mcpKey) await env.TAP.delete(`key:${user.mcpKey.hash}`);
  user.mcpKey = { hash: await sha256(key), tail: key.slice(-4), at: new Date().toISOString() };
  await env.TAP.put(`key:${user.mcpKey.hash}`, acct);
  await putJSON(env, `user:${acct}`, user);
  const cmd = `claude mcp add --transport http tap ${HOME}/mcp --header "Authorization: Bearer ${key}"`;
  return page("Your Claude key", `<a href="/me">Tap</a><h1>Your Claude key</h1>
<p>Copy it now: Tap keeps only a fingerprint of it and can't show it again.</p>
<p><code style="word-break:break-all">${esc(key)}</code></p>
<p>In your project's folder, run this once:</p>
<pre style="white-space:pre-wrap;word-break:break-all"><code>${esc(cmd)}</code></pre>
<p class="note">Then ask Claude Code, after you ship something, to "make a build video with Tap". It sends what changed (and screenshots or the live link if you like), and gets back a review link to this account. Anyone with the key can make scripts and text drafts here, never posts. Lost it? Make a new one; the old one stops working.</p>
<p><a href="/me">Back to your posts</a></p>`, { headers: { "cache-control": "no-store" } });
}

async function disconnect(env, { acct, user }) {
  const keys = [`tok:${acct}`, `user:${acct}`, `name:${user.name}`, ...(user.sessions || []).map(s => `ses:${s}`), ...(user.videos || []).map(v => `v:${v.id}`), ...(user.mcpKey ? [`key:${user.mcpKey.hash}`] : [])];
  let cursor;
  do {
    const l = await env.TAP.list({ prefix: `n:${acct}:`, cursor });
    keys.push(...l.keys.map(k => k.name));
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  await Promise.all(keys.map(k => env.TAP.delete(k)));
  return page("Disconnected", `<a href="/">Tap</a><h1>Disconnected</h1><p>Everything Tap kept for this account is deleted: the Buffer access, the copy of your posts, the counts, the bio link, the videos you made and your Claude key. To remove Tap from Buffer's side too, open your Buffer settings, then Apps.</p>`,
    { headers: { "set-cookie": "tap_sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/auth/start") return start(env);
    if (path === "/auth/callback") return callback(url, env);
    let m;
    if ((m = path.match(/^\/p\/([a-z0-9]+)\/([a-z0-9]+)$/))) return tap(env, ctx, req, m[1], m[2]);
    if ((m = path.match(/^\/t\/([a-z0-9]+)\/([a-z0-9]+)$/))) return thumb(env, m[1], m[2]);
    if ((m = path.match(/^\/v\/([A-Za-z0-9]+)\.mp4$/))) return serveVideo(env, req, m[1]);
    if (path === "/mcp") return mcp(req, env, { rand, getJSON, refreshPosts, accessToken, gql, errText });
    if ((m = path.match(/^\/i\/([A-Za-z0-9]+)$/))) {
      const { value, metadata } = await env.TAP.getWithMetadata(`img:${m[1]}`, "arrayBuffer");
      return value ? new Response(value, { headers: { "content-type": metadata?.type || "image/png", "cache-control": "public, max-age=86400", "x-robots-tag": "noindex" } }) : new Response("Not found", { status: 404 });
    }
    if (path.startsWith("/api/")) {
      const o = await owner(req, env);
      if (!o) return new Response(JSON.stringify({ error: "Sign in with Buffer first." }), { status: 401, headers: { "content-type": "application/json" } });
      if (req.method !== "GET" && req.headers.get("origin") !== HOME) return new Response("Forbidden", { status: 403 });
      return api(req, env, path, o, { rand, putJSON, refreshPosts, accessToken, gql, errText });
    }
    if (path === "/make" || path === "/make/") {
      if (!await owner(req, env)) return Response.redirect(`${HOME}/auth/start`, 302);
    }
    if ((m = path.match(/^\/go\/([a-z0-9]+)$/))) return tap(env, ctx, req, m[1], null);
    if ((m = path.match(/^\/u\/([a-z0-9]+)$/))) {
      const acct = await env.TAP.get(`name:${m[1]}`);
      const user = acct && await getJSON(env, `user:${acct}`);
      return user ? bioPage(user) : page("Not found", "<h1>No page here</h1>", { status: 404 });
    }
    const ME = { "/me": save, "/me/keep": keep, "/me/again": again, "/me/forget": forget, "/me/key": makeKey, "/me/disconnect": (req, env, o) => disconnect(env, o) };
    if (ME[path]) {
      const o = await owner(req, env);
      if (!o) return Response.redirect(`${HOME}/auth/start`, 302);
      if (req.method === "POST") {
        if (req.headers.get("origin") !== HOME) return new Response("Forbidden", { status: 403 });
        return ME[path](req, env, o);
      }
      if (path === "/me") return mePage(env, ctx, req, o);
    }
    return env.ASSETS.fetch(req);
  },
};
