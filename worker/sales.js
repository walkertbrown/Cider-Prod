// The sales site is static (site/). This Worker only runs for paths that are
// not a file there: /comiccover/* goes to the Comic Cover Worker, which holds
// the Stripe check and the drawings. Everything else is a plain 404.
export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === "/comiccover" || p.startsWith("/comiccover/")) return env.COMICCOVER.fetch(req);
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  },
};
