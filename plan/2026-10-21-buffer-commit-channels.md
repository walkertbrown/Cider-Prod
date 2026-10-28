# Buffer Commit: "Tap the one you saw", every Buffer network

Design only; the build is 28 Oct – 13 Nov. The list below is Buffer's own:
the `Service` enum on api.buffer.com, read 21 Oct 2026. Buffer's contest page
says "11 social platforms", but the API lists 14 services.

## What the API gives a post (posts:read)
`sentAt`, `text`, `channelService`, `externalLink` (the post's URL on the
network), `assets` (each with a `thumbnail`), `metadata` (per network: type
post / reel / story / short / carousel / thread..., Pinterest's destination
`url`, YouTube's `title`), and `metrics`: a list of {type, name, unit,
value}, "null until sent", refreshed about once a day. `PostMetricType` has
26 values, 8 of them deprecated (removed 1 Dec 2026, never emitted). The live
ones: reach, impressions, views, clicks, reactions, comments, shares,
reposts, saves, engagementRate, plus per-network ones (likes on Facebook,
quotes on Threads, follows on Instagram, viewers on LinkedIn video,
averageTimeWatched / totalTimeWatched on video, Substack's free and paid
subscriptions). Read on the boss's screenshots and the schema, 21 Oct.
The boss: they are in the public API docs, so a third-party app can use
them. The design counts on metrics; the first call on 28 Oct confirms it.
If it can, every tile shows views → clicks → taps: what the network saw,
what it says was clicked, and how many people actually arrived. The gap
between clicks and taps is the number nobody has. Only use the live
names; skip the deprecated ones.

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
| pinterest | post-link | Every pin has a destination `url`. Setting it to /p/<pin> counts which pin sent them, the cleanest case. On hold for our own demo: Pinterest blocks bananafest-destiny.com (market-nana, 21 Oct; the boss has appealed). |
| googlebusiness | post-link | Posts have a button link. Marked deprecated in the API, so last. |
| substack | post-link | Notes carry links; per-note link. |
| whatsapp | post-link | Channel updates carry links; per-update link. |
| startPage | dropped | Buffer is deprecating Start Page as a product: its `link_clicks` metric is removed 1 Dec 2026, before winners are announced on 7 Dec. Not built on. |

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

## Additions (the boss, 21 Oct): both, and the winner becomes a template
Read from the schema on api.buffer.com, 21 Oct: `createPostTemplate` (body
with `{{placeholders}}`, title, description, emoji; visibility private or
internal, never public), `createTag`, `createPost` with `tagIds` and
`saveToDraft`, `createIdea`. Which OAuth scope covers templates and tags is
not in the scope list (posts, ideas, account, snippets); checked 28 Oct.

1. **Keep what worked.** On a winning post the page offers "Keep this". It:
   - saves a Buffer post template. The body is the post's text with the
     specifics turned into placeholders: `{{link}}`, `{{thing}}`. The title
     carries the result, for example "Pinterest, 41 taps, 30 Oct". It then
     shows in Buffer's own composer next to the user's other templates.
   - makes a Buffer tag of the same name.
2. **Post it again.** From a kept template, one tap makes Buffer drafts
   (`saveToDraft`, never sent by us) for the networks it hasn't run on, each
   with that tag. The user checks and sends them in Buffer.
3. **Matching.** Every post with a template's tag counts toward that
   template. Whether it was posted from the button or by hand in Buffer, the
   page shows each template's record: posts, taps, sales, best network.
   Templates that stop working sink, and new winners rise.
4. **Sales.** For links to a Stripe Payment Link, the tap page adds
   `client_reference_id=<post>`. With a read-only Stripe key, each paid
   checkout counts back to its post and its template. Each post then reads
   views → clicks → taps → sales.

Our own use during the window: Comic Cover's $9 pet drawing. Its posts, its
taps and any sale are the demo video and the Build-in-Public posts.

## Money in Buffer's API (schema read 21 Oct)
No sales, revenue or orders anywhere; Buffer never sees a purchase. The
nearest things:
- `paidSubscriptions` / `freeSubscriptions`: paid and free Substack
  subscriptions attributed to one Note (experimental). This is the only real
  money count, and only on Substack. It goes in the sales column as is.
- Google Business `offer` posts carry a coupon `code`, `link`, `terms` and
  dates. A code per post shows up on the sale, even with no link tapped.
- Instagram `metadata.link` is the post's Shop Grid link: a per-post link on
  Instagram, if Shop Grid outlives Start Page (unchecked).
- `clicks`: the closest thing for every network.
So sales come from the user's Stripe (the post ID passed into the Payment
Link), plus Substack's own count.

## Build order (agreed with market-nana, 23 Oct; each step shippable alone)
1. The tap page: posts cached once a day, taps counted by request shape, the
   honest zero. If the build stops here, it is still an entry.
2. Views and clicks next to taps (reads only).
3. Keep this, then Post it again (writes; idea fallback if no template scope).
4. Stripe last: optional, off by default, in the video only if it works with
   a test-mode key.
