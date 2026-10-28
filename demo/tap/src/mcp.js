// Tap for Claude Code: a remote MCP server (Streamable HTTP, stateless JSON-RPC over POST).
//   claude mcp add --transport http tap https://tap.bananafest-destiny.com/mcp --header "Authorization: Bearer <tap key>"
// The key comes from the owner's Tap page; only its SHA-256 is kept (key:<hash> → account).
// Tools write drafts and review links, never posts: a person presses the last button.

import { safeHttp, readPages, writeScripts, underCap, captionFor, postInput, CREATE_POST, cleanTags } from "./make.js";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TEXT_NETS = new Set(["twitter", "bluesky", "threads", "linkedin", "facebook", "mastodon"]);
const JOB_TTL = 7 * 86400;

export async function sha256(s) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
}

const BUILD_VOICE = `

This is a build-in-public update: the source is a maker's notes on what they just built or shipped, not a sales page.
- Speak as the maker ("we shipped", "I built", "today"), concrete and honest. Use the real numbers in the notes.
- Hook with the most interesting change or number. One clear point per video.
- Only what is in the maker's notes is new. Anything else from the page is background: never call it shipped, new or "today".
- Several videos: each takes a different angle on what shipped (the change, how it works, who it's for, a number), not other features.
- The call to action invites people to try it or follow along, and names the site if one is given.`;

const TOOLS = [
  { name: "make_build_video",
    description: "Turn what you just built into short vertical videos for building in public. Pass what shipped (title, what changed, details with real numbers) and, if there is one, the live URL and screenshots. Tap writes the scripts and returns a review link: the owner opens it, renders the videos in their browser (voice, music optional) and drafts them to Buffer. Nothing is posted or drafted by this call.",
    inputSchema: { type: "object", required: ["title", "what_changed"], properties: {
      title: { type: "string", description: "Short name of what shipped, e.g. 'Music on every clip'" },
      what_changed: { type: "string", description: "What is new, in plain words, 1-5 sentences" },
      details: { type: "string", description: "Optional: numbers, before/after, who it's for, what's next" },
      url: { type: "string", description: "Optional: the live page to read too, and to send viewers to" },
      image_urls: { type: "array", items: { type: "string" }, description: "Optional: public https image URLs (screenshots, product images)" },
      images: { type: "array", maxItems: 4, description: "Optional: screenshots as base64 PNG or JPEG, up to 4, each under 2 MB",
        items: { type: "object", required: ["data"], properties: { data: { type: "string" }, mime_type: { type: "string" } } } },
      count: { type: "integer", minimum: 1, maximum: 5, description: "How many videos (different angles). Default 1." } } } },
  { name: "list_channels", description: "The Buffer channels connected to the owner's account.", inputSchema: { type: "object", properties: {} } },
  { name: "draft_post",
    description: "Save a text post as a Buffer draft on channels that take text only (X, Bluesky, Threads, LinkedIn, Facebook, Mastodon). Each network gets the text fitted to its length, with hashtags if given. Drafts are never sent: the owner sends them from Buffer.",
    inputSchema: { type: "object", required: ["text"], properties: {
      text: { type: "string" }, hashtags: { type: "array", items: { type: "string" } },
      channel_ids: { type: "array", items: { type: "string" }, description: "Optional: from list_channels. Default: every text channel." } } } },
  { name: "queue_status", description: "How many drafts and scheduled posts each Buffer channel has.", inputSchema: { type: "object", properties: {} } },
];

const ok = text => ({ content: [{ type: "text", text }] });
const fail = text => ({ content: [{ type: "text", text }], isError: true });

async function call(name, args, env, ctx) {
  const { acct, user, d, origin } = ctx;
  if (name === "list_channels") {
    if (!user.channels) ({ user: ctx.user } = await d.refreshPosts(env, acct, user));
    const ch = ctx.user.channels || [];
    return ok(ch.length ? ch.map(c => `${c.service}: ${c.id}`).join("\n") : "No channels connected in Buffer.");
  }
  if (name === "make_build_video") {
    const notes = [`## ${args.title}`, args.what_changed, args.details].filter(Boolean).map(String).join("\n").slice(0, 6000);
    if (!args.title || !args.what_changed) return fail("title and what_changed are required.");
    let page = { url: "", host: "", title: String(args.title).slice(0, 200), description: "", text: "", images: [], products: [] };
    let unread = "";
    if (args.url) {
      const u = safeHttp(String(args.url));
      if (!u) return fail("url isn't a public web address.");
      const read = await readPages([u]);
      if (read.error) { page.url = u.href; page.host = u.hostname; unread = `Tap couldn't read ${u.href} (${read.error}), so the scripts use your notes only; the videos still send people there.\n\n`; }
      else page = { ...read, title: page.title };
    }
    page.text = `# What shipped (the maker's notes)\n${notes}\n\n${page.text || ""}`.slice(0, 14000);
    const images = [];
    for (const im of (args.images || []).slice(0, 4)) {
      const type = /^image\/(png|jpeg|webp)$/.test(im.mime_type || "") ? im.mime_type : "image/png";
      let bytes; try { bytes = Uint8Array.from(atob(String(im.data).replace(/^data:[^,]*,/, "")), c => c.charCodeAt(0)); } catch { return fail("An image isn't valid base64."); }
      if (bytes.length > 2 * 1048576) return fail("Each image must be under 2 MB.");
      const id = d.rand(12).replace(/[^A-Za-z0-9]/g, "").slice(0, 14);
      await env.TAP.put(`img:${id}`, bytes, { expirationTtl: JOB_TTL, metadata: { type } });
      images.push(`${origin}/i/${id}`);
    }
    for (const u of (args.image_urls || []).slice(0, 8)) { const x = safeHttp(String(u)); if (x) images.push(x.href); }
    page.images = [...images, ...page.images].slice(0, 24);
    if (!page.host) page.host = page.url ? new URL(page.url).hostname : "";
    const capped = await underCap(env, acct, "script");
    if (capped) return fail(capped);
    const out = await writeScripts(env, page, Math.max(1, Math.min(5, +args.count || 1)), BUILD_VOICE);
    if (out.error) return fail(out.error);
    const id = d.rand(12).replace(/[^A-Za-z0-9]/g, "").slice(0, 14);
    await env.TAP.put(`job:${id}`, JSON.stringify({ acct, page, videos: out.videos, note: out.note || "", at: Date.now() }), { expirationTtl: JOB_TTL });
    const link = `${origin}/make/?job=${id}`;
    return ok(unread + `Review link (the owner opens it, renders, and drafts to Buffer): ${link}\n\n` +
      out.videos.map((v, i) => `Video ${i + 1}: ${v.angle}\n` + v.scenes.map(s => `  - ${s.text}`).join("\n") + `\n  Caption: ${v.caption}`).join("\n\n") +
      `\n\nThe link lasts 7 days. Nothing has been posted or drafted.`);
  }
  if (name === "draft_post") {
    const text = String(args.text || "").trim();
    if (!text) return fail("text is required.");
    const textCh = (user.channels || []).filter(c => TEXT_NETS.has(c.service) && (!args.channel_ids?.length || args.channel_ids.includes(c.id)));
    if (!textCh.length) return fail("No text channels (X, Bluesky, Threads, LinkedIn, Facebook, Mastodon) are connected in Buffer. Instagram, TikTok and YouTube need a video: use make_build_video.");
    const token = await d.accessToken(env, acct);
    if (!token) return fail("Buffer access has lapsed. The owner needs to sign in to Tap again.");
    const lines = [];
    for (const ch of textCh) {
      const r = await d.gql(token, CREATE_POST, { i: postInput(ch, { text: captionFor(ch.service, text, cleanTags(args.hashtags)) }) });
      const pid = r.data?.createPost?.post?.id;
      lines.push(`${ch.service}: ${pid ? "drafted" : "failed: " + (d.errText(r) || r.data?.createPost?.message || r.status)}`);
    }
    return ok(lines.join("\n") + "\nDrafts only: nothing is sent until the owner sends it from Buffer.");
  }
  if (name === "queue_status") {
    const token = await d.accessToken(env, acct);
    if (!token) return fail("Buffer access has lapsed. The owner needs to sign in to Tap again.");
    const Q = `query($o:OrganizationId!,$s:[PostStatus!]){ posts(first:100, input:{organizationId:$o, filter:{status:$s}}){ edges{ node{ channelService } } } }`;
    const count = async status => {
      const r = await d.gql(token, Q, { o: user.orgId, s: [status] });
      if (!r.data) return null;
      const by = {}; for (const { node } of r.data.posts.edges) by[node.channelService] = (by[node.channelService] || 0) + 1; return by;
    };
    const [drafts, scheduled] = await Promise.all([count("draft"), count("scheduled")]);
    const nets = new Set([...Object.keys(drafts || {}), ...Object.keys(scheduled || {}), ...(user.channels || []).map(c => c.service)]);
    return ok([...nets].map(n => `${n}: ${drafts?.[n] || 0} drafts, ${scheduled ? scheduled[n] || 0 : "?"} scheduled`).join("\n") || "No channels.");
  }
  return fail(`Unknown tool: ${name}`);
}

async function handle(msg, env, ctx) {
  const { id, method, params = {} } = msg || {};
  const reply = result => ({ jsonrpc: "2.0", id, result });
  const error = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return error(-32600, "Invalid request");
  if (id === undefined) return null; // a notification
  if (method === "initialize") return reply({
    protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
    capabilities: { tools: {} }, serverInfo: { name: "tap", title: "Tap for Buffer", version: "0.1.0" },
    instructions: "Tap turns what you just built into short videos and Buffer drafts. Call make_build_video after shipping something; give real numbers and the live URL. The owner reviews and drafts from the link it returns.",
  });
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: TOOLS });
  if (method === "tools/call") {
    try { return reply(await call(params.name, params.arguments || {}, env, ctx)); }
    catch (e) { return reply(fail(`Tap hit an error: ${e.message}`)); }
  }
  return error(-32601, `Method not found: ${method}`);
}

export async function mcp(req, env, d) {
  const url = new URL(req.url);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-allow-methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Tap's MCP endpoint takes POST (Streamable HTTP, no SSE stream).", { status: 405, headers: { allow: "POST", ...cors } });
  const key = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i)?.[1];
  const acct = key && await env.TAP.get(`key:${await sha256(key)}`);
  const user = acct && await d.getJSON(env, `user:${acct}`);
  if (!user) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Missing or unknown Tap key. Make one on https://tap.bananafest-destiny.com/me" } }),
    { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="tap"', ...cors } });
  let body; try { body = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: cors }); }
  const ctx = { acct, user, d, origin: url.origin };
  const out = Array.isArray(body) ? (await Promise.all(body.map(m => handle(m, env, ctx)))).filter(Boolean) : await handle(body, env, ctx);
  if (!out || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202, headers: cors });
  return Response.json(out, { headers: cors });
}
