// Comic Cover: the free cover maker is static (public/). This Worker adds the
// paid part: $9 buys 3 AI drawings, checked against Stripe on every call.
//   GET  /paid?session_id=…        the same page, in paid mode
//   GET  /api/order?session_id=…   { left, drawings: [{ n, mime }] }
//   POST /api/draw                 { session_id, photo (base64 jpeg), color, power }
//   GET  /api/img/<session>/<n>    the drawing, as base64 text (x-mime header)
// The photo is passed straight to the image API and never stored. Drawings are
// kept in KV for 30 days. Base64 is never decoded here except for the OpenAI
// fallback, to stay well inside the Worker CPU limit.

const TRIES = 3;
const TTL = 30 * 24 * 3600;
const SID = /^cs_(live|test)_[A-Za-z0-9]{10,200}$/;
const COSTUME = {
  red: "red and gold", blue: "blue and red", green: "green and black", purple: "purple and silver",
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

async function paidSession(env, sid) {
  if (!SID.test(sid || "")) return { ok: false, status: 400, error: "That is not an order link." };
  const r = await fetch(`${env.STRIPE_API || "https://api.stripe.com"}/v1/checkout/sessions/${sid}`, {
    headers: { authorization: "Basic " + btoa(env.STRIPE_RESTRICTED_KEY + ":") },
  });
  if (r.status === 404) return { ok: false, status: 404, error: "No order with that link." };
  if (!r.ok) return { ok: false, status: 502, error: "Could not reach Stripe. Try again in a minute." };
  const s = await r.json();
  if (s.payment_link !== env.PAYMENT_LINK) return { ok: false, status: 403, error: "That order is not for AI drawings." };
  if (s.payment_status !== "paid") return { ok: false, status: 402, error: "That order is not paid yet." };
  return { ok: true };
}

async function getOrder(env, sid) {
  return (await env.COVERS.get(`o:${sid}`, "json")) || { used: 0, drawings: [] };
}
const putOrder = (env, sid, o) => env.COVERS.put(`o:${sid}`, JSON.stringify(o), { expirationTtl: TTL });

function prompt(color, power) {
  return [
    "Redraw the person, people or pet in this photo as the hero of a classic American superhero comic book cover.",
    "Keep their real face, hair or fur, skin tone and markings, so the people who know them recognise them at once.",
    `Give them an original superhero costume in ${COSTUME[color] || COSTUME.red}, with a cape and a simple chest emblem (a shape, no letters).`,
    power ? `Their power or story: ${power}.` : "",
    "Heroic low-angle pose, three-quarter or full body, face in the upper middle of the image, city skyline behind.",
    "Bold black ink lines, flat bright colours, Ben-Day halftone dots, 1960s comic printing look.",
    "Full-bleed artwork to every edge: no border, no frame, no aged paper edges, no empty banners or title boxes.",
    "No text, no letters, no logos, no speech bubbles anywhere. Not any existing character.",
  ].filter(Boolean).join(" ");
}

// Pull "key": "<base64>" out of a large JSON body without parsing it all.
function grab(text, key) {
  const i = text.indexOf(`"${key}"`);
  if (i < 0) return null;
  const start = text.indexOf('"', text.indexOf(":", i) + 1) + 1;
  const end = text.indexOf('"', start);
  return start > 0 && end > start ? text.slice(start, end) : null;
}

async function gemini(env, photo, text) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent", {
    method: "POST",
    signal: AbortSignal.timeout(45000),
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: photo } }, { text }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:5" } },
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const data = grab(body, "data");
  if (!data || data.length < 1000) throw new Error("gemini: no image");
  return { data, mime: grab(body, "mimeType") || "image/png" };
}

async function openai(env, photo, text) {
  const bin = Uint8Array.from(atob(photo), c => c.charCodeAt(0));
  const f = new FormData();
  f.append("model", "gpt-image-2");
  f.append("image", new Blob([bin], { type: "image/jpeg" }), "photo.jpg");
  f.append("prompt", text);
  f.append("size", "1024x1536");
  f.append("quality", "medium");
  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    signal: AbortSignal.timeout(80000),
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: f,
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`openai ${r.status}`);
  const data = grab(body, "b64_json");
  if (!data || data.length < 1000) throw new Error("openai: no image");
  return { data, mime: "image/png" };
}

async function draw(req, env) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const { session_id: sid, photo, color } = b;
  const power = String(b.power || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (typeof photo !== "string" || photo.length < 1000 || photo.length > 3_000_000 || !/^[A-Za-z0-9+/=]+$/.test(photo))
    return json({ error: "Add a photo first." }, 400);
  const s = await paidSession(env, sid);
  if (!s.ok) return json({ error: s.error }, s.status);

  // Reserve the try before drawing; give it back if both image APIs fail.
  const o = await getOrder(env, sid);
  if (o.used >= TRIES) return json({ error: "All 3 drawings on this order are used.", left: 0, drawings: o.drawings }, 403);
  o.used++;
  await putOrder(env, sid, o);

  const text = prompt(color, power);
  let img, by;
  try { img = await gemini(env, photo, text); by = "gemini"; }
  catch (e1) {
    try { img = await openai(env, photo, text); by = "openai"; }
    catch (e2) {
      console.log("draw failed", e1.message, e2.message);
      const back = await getOrder(env, sid);
      back.used = Math.max(0, back.used - 1);
      await putOrder(env, sid, back);
      return json({ error: "The artist could not draw that photo. Your try was not used. Try a different photo, or try again.", left: TRIES - back.used, drawings: back.drawings }, 502);
    }
  }
  const n = o.used;
  await env.COVERS.put(`i:${sid}:${n}`, img.data, { expirationTtl: TTL, metadata: { mime: img.mime } });
  const cur = await getOrder(env, sid);
  cur.drawings = [...cur.drawings.filter(d => d.n !== n), { n, mime: img.mime, by }];
  cur.used = Math.max(cur.used, n);
  await putOrder(env, sid, cur);
  return json({ n, left: TRIES - cur.used, drawings: cur.drawings });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/paid" && req.method === "GET") {
      const r = await env.ASSETS.fetch(new Request(new URL("/", url), req));
      const h = new Headers(r.headers);
      h.set("x-robots-tag", "noindex");
      h.set("cache-control", "no-store");
      return new Response(r.body, { status: r.status, headers: h });
    }
    if (p === "/api/order" && req.method === "GET") {
      const sid = url.searchParams.get("session_id");
      const s = await paidSession(env, sid);
      if (!s.ok) return json({ error: s.error }, s.status);
      const o = await getOrder(env, sid);
      return json({ left: TRIES - o.used, drawings: o.drawings });
    }
    if (p === "/api/draw" && req.method === "POST") return draw(req, env);

    const m = p.match(/^\/api\/img\/(cs_[A-Za-z0-9_]+)\/([1-3])$/);
    if (m && req.method === "GET") {
      const s = await paidSession(env, m[1]);
      if (!s.ok) return json({ error: s.error }, s.status);
      const { value, metadata } = await env.COVERS.getWithMetadata(`i:${m[1]}:${m[2]}`);
      if (!value) return json({ error: "That drawing is gone (they are kept 30 days)." }, 404);
      return new Response(value, { headers: {
        "content-type": "text/plain", "x-mime": metadata?.mime || "image/png", "cache-control": "private, max-age=86400",
      } });
    }
    return env.ASSETS.fetch(req);
  },
};
