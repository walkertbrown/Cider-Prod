// Tap: which of your Buffer posts sent people. Buffer Commit, 28 Oct – 13 Nov.
//   GET  /auth/start      redirect to Buffer's consent screen
//   GET  /auth/callback   exchange the code, keep the tokens, sign the owner in
//   GET  /me              the owner's page: each post, its taps, its destination
//   POST /me              save destinations
//   POST /me/disconnect   delete everything Tap keeps for the account
//   GET  /u/<name>        the public bio page: one tile per post
//   GET  /p/<name>/<post> count a tap, then send the visitor on
//   GET  /go/<name>       the bio page's skip link, counted the same way
// KV: tok:<acct> tokens · user:<acct> posts and settings · name:<name> → acct
//     ses:<sid> → acct · n:<acct>:<post> {p, f} counts. Visitors get no cookie.

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
function firstLink(text) {
  const m = String(text || "").match(/\b(https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s)]*)?/i);
  if (!m) return "";
  const url = (m[1] || "https://") + m[2] + (m[3] || "");
  return url.replace(/[.,;:!?'"]+$/, "");
}

function postTitle(n) {
  const t = n.metadata?.title || String(n.text || "").split("\n").find(l => l.trim()) || "";
  return t.length > 90 ? t.slice(0, 88).trimEnd() + "…" : t;
}

const POSTS_Q = `query($o:OrganizationId!){ posts(first:50, input:{organizationId:$o, filter:{status:[sent]}}){
  edges { node { id channelService sentAt text externalLink assets { thumbnail }
    metadata { __typename ... on YoutubePostMetadata { title } ... on TiktokPostMetadata { title } } } } } }`;

async function refreshPosts(env, acct, user) {
  const token = await accessToken(env, acct);
  if (!token) return { user, error: "Buffer access has lapsed. Sign in again." };
  const res = await gql(token, POSTS_Q, { o: user.orgId });
  if (!res.data) return { user, error: errText(res) || `Buffer answered ${res.status}` };
  user.posts = res.data.posts.edges.map(({ node: n }) => ({
    id: n.id, service: n.channelService, sentAt: n.sentAt, title: postTitle(n),
    thumb: n.assets?.find(a => a.thumbnail)?.thumbnail || "", link: n.externalLink || "", found: firstLink(n.text),
  }));
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

// ---- Pages -----------------------------------------------------------------

const NET = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", twitter: "X", threads: "Threads", bluesky: "Bluesky", mastodon: "Mastodon", pinterest: "Pinterest" };
const net = s => NET[s] || s;
const day = iso => iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";

function bioPage(user) {
  const tiles = user.posts.map(p => `<a class="tile" href="/p/${user.name}/${shortId(p.id)}">
${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : ""}<span>${esc(p.title)}<br><small>${esc(net(p.service))} · ${esc(day(p.sentAt))}</small></span></a>`).join("");
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
  const rows = user.posts.map(p => {
    const n = c[p.id] || { p: 0, f: 0 };
    return `<tr><td>${p.thumb ? `<img class="thumb" src="${esc(p.thumb)}" alt="">` : ""}</td>
<td>${p.link ? `<a href="${esc(p.link)}">${esc(p.title)}</a>` : esc(p.title)}<br><span class="note">${esc(net(p.service))} · ${esc(day(p.sentAt))}</span>
<input type="url" name="d_${esc(p.id)}" value="${esc(user.dest?.[p.id] || "")}" placeholder="${esc(p.found || user.mainDest || "Where should this post send people?")}" aria-label="Destination"></td>
<td><span class="n">${n.p}</span><br><span class="note">${n.f ? `+${n.f} fetcher${n.f === 1 ? "" : "s"}` : ""}</span></td></tr>`;
  }).join("");
  const skip = c.skip || { p: 0, f: 0 };
  return page("Your posts", `
<a href="/">Tap</a>
<h1>Your posts</h1>
${error ? `<p class="note" style="color:#c0392b">Couldn't refresh from Buffer: ${esc(error)} ${error.includes("Sign in") ? '<a href="/auth/start">Sign in</a>' : ""}</p>` : ""}
<p>Your bio link: <a href="${bio}"><b>${bio}</b></a><br><span class="note">Put it in your Instagram, TikTok or YouTube bio. Visitors pick the post they saw, and Tap counts it before sending them on.</span></p>
<p><span class="n">${total}</span> ${total === 1 ? "person" : "people"} so far${total ? "" : ". Nothing is counted until someone taps your bio link"}. ${skip.p} of them skipped straight to the site.</p>
<form method="post" action="/me">
<p><label>Main site (for the skip link, and posts with no address of their own)<br>
<input type="url" name="main" value="${esc(user.mainDest || "")}" placeholder="https://"></label></p>
<table><tr><th></th><th>Post, and where it sends people</th><th>People</th></tr>${rows || '<tr><td></td><td class="note">No sent posts in Buffer yet.</td><td></td></tr>'}</table>
<p><button class="primary">Save</button> <a class="btn" href="/me?refresh">Refresh from Buffer</a></p>
</form>
<p class="note">A person is counted when a browser opens the link as a page. Link previews, checkers and crawlers are counted apart as fetchers. Posts were read from Buffer ${user.postsAt ? new Date(user.postsAt).toUTCString().slice(5, 22) + " UTC" : "not yet"}. Buffer doesn't let outside apps read post views or clicks yet, so this page shows only what Tap counts itself.</p>
<form method="post" action="/me/disconnect" onsubmit="return confirm('Delete everything Tap keeps for this account?')"><button>Disconnect and delete</button></form>`);
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

async function disconnect(env, { acct, user }) {
  const keys = [`tok:${acct}`, `user:${acct}`, `name:${user.name}`, ...(user.sessions || []).map(s => `ses:${s}`)];
  let cursor;
  do {
    const l = await env.TAP.list({ prefix: `n:${acct}:`, cursor });
    keys.push(...l.keys.map(k => k.name));
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  await Promise.all(keys.map(k => env.TAP.delete(k)));
  return page("Disconnected", `<a href="/">Tap</a><h1>Disconnected</h1><p>Everything Tap kept for this account is deleted: the Buffer access, the copy of your posts, the counts and the bio link. To remove Tap from Buffer's side too, open your Buffer settings, then Apps.</p>`,
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
    if ((m = path.match(/^\/go\/([a-z0-9]+)$/))) return tap(env, ctx, req, m[1], null);
    if ((m = path.match(/^\/u\/([a-z0-9]+)$/))) {
      const acct = await env.TAP.get(`name:${m[1]}`);
      const user = acct && await getJSON(env, `user:${acct}`);
      return user ? bioPage(user) : page("Not found", "<h1>No page here</h1>", { status: 404 });
    }
    if (path === "/me" || path === "/me/disconnect") {
      const o = await owner(req, env);
      if (!o) return Response.redirect(`${HOME}/auth/start`, 302);
      if (req.method === "POST") {
        if (req.headers.get("origin") !== HOME) return new Response("Forbidden", { status: 403 });
        return path === "/me" ? save(req, env, o) : disconnect(env, o);
      }
      if (path === "/me") return mePage(env, ctx, req, o);
    }
    return env.ASSETS.fetch(req);
  },
};
