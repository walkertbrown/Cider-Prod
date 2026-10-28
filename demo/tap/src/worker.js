// Tap: which of your Buffer posts sent people. Buffer Commit, 28 Oct – 13 Nov.
// Day 1: sign in with Buffer (OAuth, PKCE, confidential client) and a first
// check of what the granted access can read and write.
//   GET /auth/start      redirect to Buffer's consent screen
//   GET /auth/callback   exchange the code, keep the tokens, run the check
// Tokens live in KV under the Buffer account id, never in a cookie.

const HOME = "https://tap.bananafest-destiny.com";
const REDIRECT = HOME + "/auth/callback";
const SCOPE = "account:read posts:read posts:write ideas:read ideas:write offline_access";
const API = "https://api.buffer.com";

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><link rel="icon" href="/logo.png">
<script src="https://pulse.bananafest-destiny.com/p.js" data-site="tap.bananafest-destiny.com" defer></script>
<style>:root{--bg:#fbf8f1;--fg:#1d1b16;--muted:#5f5a4f;--line:#e2dccd}
@media (prefers-color-scheme:dark){:root{--bg:#15140f;--fg:#efeadc;--muted:#a59f8f;--line:#2e2b22}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}a{color:inherit}
table{border-collapse:collapse;width:100%}td{border-bottom:1px solid var(--line);padding:6px 4px;vertical-align:top;overflow-wrap:anywhere}
.ok{color:#2e8b57}.no{color:#c0392b}.note{font-size:14px;color:var(--muted)}</style></head>
<body><main><a href="/">Tap</a><h1>${esc(title)}</h1>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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

// The first check: one row per question the plan left open.
async function check(token) {
  const rows = [];
  const add = (q, ok, detail) => rows.push({ q, ok, detail });
  const acc = await gql(token, "{ account { id timezone organizations { id name channelCount } } }");
  const orgs = acc.data?.account?.organizations || [];
  add("Read the account (account:read)", !!acc.data?.account, acc.data ? `${orgs.length} organization(s): ${orgs.map(o => `${o.name}, ${o.channelCount} channels`).join("; ")}` : errText(acc));
  const org = orgs[0];
  if (!org) return { rows, accountId: acc.data?.account?.id };

  const ch = await gql(token, "query($o:OrganizationId!){ channels(input:{organizationId:$o}){ id service name } }", { o: org.id });
  add("Read the channels", !!ch.data, ch.data ? ch.data.channels.map(c => c.service).join(", ") || "none connected" : errText(ch));

  const posts = await gql(token, `query($o:OrganizationId!){ posts(first:5, input:{organizationId:$o, filter:{status:[sent]}}){
    edges { node { id channelService sentAt externalLink metrics { type value } metricsUpdatedAt } } } }`, { o: org.id });
  const nodes = posts.data?.posts?.edges?.map(e => e.node) || [];
  add("Read sent posts (posts:read)", !!posts.data, posts.data ? `${nodes.length} sent post(s) in the first page` : errText(posts));
  const withM = nodes.filter(n => Array.isArray(n.metrics) && n.metrics.length);
  add("Read post metrics", posts.data ? (nodes.length ? withM.length > 0 : null) : false,
    posts.data ? (nodes.length ? `${withM.length} of ${nodes.length} have metrics. ${withM[0] ? withM[0].channelService + ": " + withM[0].metrics.map(m => `${m.type} ${m.value}`).join(", ") : ""}` : "No sent posts to read metrics from yet. The field itself answered without an error.") : errText(posts));

  const tpl = await gql(token, "query($o:OrganizationId!){ postTemplates(first:1, input:{organizationId:$o}){ edges { node { id } } } }", { o: org.id });
  add("Read templates", !!tpl.data, tpl.data ? "allowed" : errText(tpl));
  const tags = await gql(token, "query($o:OrganizationId!){ tagsV2(first:1, input:{organizationId:$o}){ edges { node { id } } } }", { o: org.id });
  add("Read tags", !!tags.data, tags.data ? "allowed" : errText(tags));

  // Writes: make one of each, named so it's obvious, then delete it straight away.
  const ct = await gql(token, `mutation($o:OrganizationId!){ createPostTemplate(input:{organizationId:$o, title:"Tap check (deleted at once)", description:"Tap check", body:"Tap check {{link}}", visibility:private}){
    __typename ... on CreatePostTemplateSuccess { postTemplate { id } } ... on VoidMutationError { message } } }`, { o: org.id });
  const tid = ct.data?.createPostTemplate?.postTemplate?.id;
  let tdel = "";
  if (tid) { const d = await gql(token, "mutation($i:PostTemplateId!){ deletePostTemplate(input:{id:$i}){ __typename } }", { i: tid }); tdel = d.data?.deletePostTemplate?.__typename === "EmptySuccess" ? ", deleted" : `, NOT deleted: ${errText(d) || d.data?.deletePostTemplate?.__typename}`; }
  add("Create a template (then delete it)", !!tid, tid ? "allowed" + tdel : errText(ct) || ct.data?.createPostTemplate?.message);

  const cg = await gql(token, `mutation($o:OrganizationId!){ createTag(input:{organizationId:$o, tag:{name:"tap-check", color:"#e8b830"}}){
    __typename ... on TagActionSuccess { tag { id } } ... on InvalidInputError { message } ... on UnauthorizedError { message } ... on UnexpectedError { message } ... on DuplicateError { message } } }`, { o: org.id });
  const gid = cg.data?.createTag?.tag?.id;
  let gdel = "";
  if (gid) { const d = await gql(token, "mutation($i:TagId!){ deleteTag(input:{id:$i}){ __typename } }", { i: gid }); gdel = d.data?.deleteTag?.__typename === "DeleteTagActionSuccess" ? ", deleted" : `, NOT deleted: ${errText(d) || d.data?.deleteTag?.__typename}`; }
  add("Create a tag (then delete it)", !!gid, gid ? "allowed" + gdel : errText(cg) || `${cg.data?.createTag?.__typename}: ${cg.data?.createTag?.message || ""}`);

  return { rows, accountId: acc.data.account.id };
}

async function callback(url, env) {
  const { searchParams: q } = url;
  if (q.get("error")) return page("Not connected", `<p>Buffer said: ${esc(q.get("error"))}. Nothing was kept.</p><p><a href="/auth/start">Try again</a></p>`, 403);
  const state = q.get("state") || "", code = q.get("code") || "";
  const verifier = state && await env.TAP.get(`st:${state}`);
  if (!verifier || !code) return page("That sign-in link has expired", `<p><a href="/auth/start">Start again</a></p>`, 400);
  await env.TAP.delete(`st:${state}`);

  const r = await fetch("https://auth.buffer.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.BUFFER_CLIENT_ID, client_secret: env.BUFFER_CLIENT_SECRET,
      grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier,
    }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.access_token) return page("Buffer didn't hand over access", `<p>${esc(tok.error || r.status)}: ${esc(tok.error_description || "")}</p>`, 502);

  const { rows, accountId } = await check(tok.access_token);
  if (accountId) await env.TAP.put(`tok:${accountId}`, JSON.stringify({
    access_token: tok.access_token, refresh_token: tok.refresh_token || null,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000, scope: tok.scope || "", at: new Date().toISOString(),
  }));
  const mark = ok => ok === null ? "–" : ok ? '<span class="ok">yes</span>' : '<span class="no">no</span>';
  return page("Connected to Buffer", `
<p>Buffer granted: <code>${esc(tok.scope || "(not stated)")}</code>. Refresh token: ${tok.refresh_token ? "yes" : "no"}. Access lasts ${esc(tok.expires_in || "?")} seconds.</p>
<table>${rows.map(x => `<tr><td>${esc(x.q)}</td><td>${mark(x.ok)}</td><td>${esc(x.detail)}</td></tr>`).join("")}</table>
<p class="note">This is Tap's first-day check. The template and tag it made were named "Tap check" and deleted straight away.</p>`);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/auth/start") return start(env);
    if (url.pathname === "/auth/callback") return callback(url, env);
    return env.ASSETS.fetch(req);
  },
};
