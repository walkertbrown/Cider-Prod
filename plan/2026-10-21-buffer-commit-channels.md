# Buffer Commit: "Tap the one you saw", every Buffer network

Design only; the build is 28 Oct – 13 Nov. The list below is Buffer's own:
the `Service` enum on api.buffer.com, read 21 Oct 2026. Buffer's contest page
says "11 social platforms", but the API lists 14 services.

## What the API gives a post (posts:read)
`sentAt`, `text`, `channelService`, `externalLink` (the post's URL on the
network), `assets` (each with a `thumbnail`), `metadata` (per network: type
post / reel / story / short / carousel / thread..., Pinterest's destination
`url`, YouTube's `title`), and `metrics`: reach, impressions, views, clicks
and more, "null until sent", refreshed about once a day.
Unchecked: whether an OAuth app with posts:read can read `metrics`
(market-nana read that no scope covers them). First thing to test on 28 Oct.
If it can, every tile shows "views → taps", which is the number nobody has.

## Two ways a visitor arrives
- **Bio mode**, for networks where a post can't carry a working link. The
  bio link goes to the page and the visitor taps the post they saw. A skip
  link goes straight to the site. Both are counted.
- **Post-link mode**, for networks where links in posts work. Each post gets
  its own short link, /p/<post>, that counts and passes the visitor through
  with no tap. The user pastes it into the next post, or the app adds it as
  the first comment (posts:write; ships last, if at all).

## Per network
| Service | Mode | Plan |
|---|---|---|
| instagram | bio | The main case. Reels, posts and carousels as tiles, using Buffer's thumbnail. Stories: a link sticker to /p/<post>, so it counts without a tap. |
| tiktok | bio | Tiles from video thumbnails. Bio links need a business account or enough followers; the page says so. |
| youtube | bio | Shorts descriptions don't give a working link, so tile by title and thumbnail. Long videos: per-video link in the description. |
| threads | both | Bio tiles, plus /p/<post> for posts that carry a link. |
| facebook | post-link | Links work; /p/<post> in the post or in the first comment (metadata has `firstComment`). |
| linkedin | post-link | Same, with the first comment, since posts with links lose reach. |
| twitter (X) | post-link | /p/<post> in the post, or in the first reply of a thread. |
| bluesky | post-link | Links work; tiles too, for the profile link. |
| mastodon | post-link | Links work. The page carries rel="me", so it can be a verified profile link. |
| pinterest | post-link | Every pin has a destination `url`. Setting it to /p/<pin> counts which pin sent them, the cleanest case. |
| googlebusiness | post-link | Posts have a button link. Marked deprecated in the API, so last. |
| substack | post-link | Notes carry links; per-note link. |
| whatsapp | post-link | Channel updates carry links; per-update link. |
| startPage | page | Buffer's own link-in-bio page. Ours isn't a rival: put the tap page on the Start Page, or the other way round. A Start Page tile per post, if the API exposes it (unchecked). |

## The same for all
- Counting is docent's: a tap counts only if the request looks like a person
  navigating (sec-fetch-mode navigate or sec-fetch-dest document, an accept
  header asking for HTML, an accept-language). Link checkers and other
  fetchers get their own published count.
- An empty test account shows the page built from whatever posts exist, an
  honest zero, and one line on what is and isn't counted.
- Only a Buffer sign-in can make a page. Destinations are checked against a
  phishing list, and every page has a report link.
- Rate limits are per app and shared by every user. Each user's posts are
  saved and refreshed a few times a day, never per page view, one refresh at
  a time, because refresh tokens are single-use.
- On tap.bananafest-destiny.com (the boss: a subdomain).
- Build-in-public: the contest has a Build-in-Public Award. Our plan/actual
  log is public already.
