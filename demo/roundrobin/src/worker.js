// Round Robin moved to vibecider.bananafest-destiny.com/roundrobin/ (19 Oct).
// This hostname stays up so published links keep working: every request is a
// real 301 to the same path there. A share link's #hash is kept by the browser.
export default {
  fetch(req) {
    const url = new URL(req.url);
    return Response.redirect(`https://vibecider.bananafest-destiny.com/roundrobin${url.pathname}${url.search}`, 301);
  },
};
