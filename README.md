# TubeScout: YouTube competitor, keyword and channel research

TubeScout is a self-hosted YouTube research tool for creators, similar to vidIQ and TubeBuddy. It combines:

- **Competitor research.** Compare up to 8 channels, find their outlier videos, and see which keywords, title styles and upload times win in your niche.
- **Keyword research with search demand.** Get real YouTube autocomplete signals, Google Trends for YouTube Search, Google search volume, and opportunity scores.
- **AI Studio.** Claude writes titles, descriptions with tags, video ideas and script outlines from real YouTube data (your competitors' outlier videos and YouTube autocomplete), and TubeScout scores the results with transparent checks.
- **Video and channel audits.** A 0–100 SEO score for any public video and a weighted audit of any channel, with fixes ordered by impact.
- **Search rank tracking.** Where a channel's videos rank in YouTube search for a keyword, checked about once a day.
- **Daily tracking.** Growth charts for you and your competitors, videos trending right now, and new uploads.
- **Alerts.** New uploads, breakout videos, subscriber milestones and ranking changes, in the app and optionally on Telegram, Discord, Slack or any webhook.
- **Your own private analytics.** Watch time, retention curves, traffic sources, the search terms that found you, audience age and countries.
- **Chrome extension.** TubeScout panels on YouTube watch, channel and search pages, served by your own TubeScout server ([extension/README.md](extension/README.md)).

It needs only Node.js 20+ and has no build step. The only npm dependency is the official Anthropic SDK (`@anthropic-ai/sdk`), and only AI Studio uses it: without `npm install`, everything else still works.

## Quick start

```bash
cp .env.example .env        # then fill in the keys you want (only YOUTUBE_API_KEY is needed to start)
npm install                 # optional: only needed for AI Studio
npm start                   # http://localhost:3000
```

Without `YOUTUBE_API_KEY`, TubeScout runs in **demo mode**: channel, video and search-result numbers are *synthetic* (a yellow banner says so). YouTube autocomplete ideas are real even in demo mode, because they need no key.

## Keys and what each one unlocks

| Key | Unlocks | Cost |
|---|---|---|
| `YOUTUBE_API_KEY` | Real channel, competitor, keyword, audit, ranking and tracking data | Free, within Google's daily quota (see [API quota](#api-quota)) |
| *(none)* | YouTube autocomplete: keyword ideas, questions, autocomplete strength | Free |
| `SERPAPI_KEY` | Google Trends **YouTube Search** interest over 12 months, plus rising and top related searches | SerpApi free plan: 250 searches/month (2 per keyword). Paid plans from $25/month |
| `KE_API_KEY` | Monthly **Google** search volume, CPC and competition for the keyword and its top ideas | Keywords Everywhere credits: 1 per keyword (plans from $7/month billed yearly, 100K credits/year) |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | The **My channel** tab with your private YouTube Analytics | Free |
| `ANTHROPIC_API_KEY` | **AI Studio** (Claude) | Billed by Anthropic per token (see [AI Studio costs](#ai-studio-costs)) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL` | Alert messages on Telegram, Discord, Slack or any webhook | Free |

### 1. YouTube Data API key
1. Open <https://console.cloud.google.com/>, create a project, and open **APIs & Services → Library**.
2. Enable **YouTube Data API v3**.
3. Go to **Credentials → Create credentials → API key**, and put the key in `.env` as `YOUTUBE_API_KEY`.

### 2. My channel (Google sign-in)
1. In the same project, also enable **YouTube Analytics API**.
2. Open the **OAuth consent screen**, choose *External*, and add your Google account under *Test users*.
3. Go to **Credentials → Create credentials → OAuth client ID → Web application**. Add the authorized redirect URI `http://localhost:3000/auth/google/callback`. If you host TubeScout elsewhere, use your `PUBLIC_URL` instead of `http://localhost:3000`.
4. Put the client ID and secret in `.env`, restart, open **My channel**, and click **Connect with Google**.

TubeScout requests read-only access: `youtube.readonly` and `yt-analytics.readonly`. It also requests `yt-analytics-monetary.readonly`, but only when `ENABLE_REVENUE=1`. The sign-in is stored only in `data/oauth.json` with owner-only file permissions. **Disconnect** deletes it and revokes it at Google.

### 3. AI Studio (Anthropic)
1. Create an API key at <https://console.anthropic.com/>.
2. Add `ANTHROPIC_API_KEY=...` to `.env`.
3. Run `npm install` to install the official `@anthropic-ai/sdk`. Without it, the AI endpoints answer 503 and the rest of TubeScout works as usual.
4. Restart TubeScout.

Instead of a key, you can set `AI_ENABLED=1` and let the Anthropic SDK find credentials itself (for example a profile saved with `ant auth login`). The key is never logged or sent to the browser.

### 4. Alert delivery (optional)
- **Telegram:** message [@BotFather](https://t.me/BotFather) and send `/newbot` to get a token. Send your bot any message, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id`. Then set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (a group's ID is negative; a channel can also be `@channelusername`).
- **Discord / Slack / anything else:** set `ALERT_WEBHOOK_URL` to a Discord channel webhook or a Slack incoming webhook (`https://hooks.slack.com/services/…`); both are detected automatically. Any other URL receives a JSON POST `{ "text": "...", "alert": { ... } }`, for example n8n, Zapier or your own script.
- Restart TubeScout, then use **Send test message** in the Alerts tab.

### All environment variables

TubeScout reads `.env` at startup (variables already set in the environment win). Comments must be on their own line. An empty value means "use the default". Restart after changing anything.

| Variable | Default | Meaning |
|---|---|---|
| `YOUTUBE_API_KEY` | unset (demo mode) | YouTube Data API v3 key |
| `DEMO` | unset | `1` forces demo mode (synthetic data) even when `YOUTUBE_API_KEY` is set |
| `SERPAPI_KEY` | unset | SerpApi key for Google Trends (YouTube Search) |
| `KE_API_KEY` | unset | Keywords Everywhere key for Google search volume |
| `KE_COUNTRY` | the region you search with, else `us` | Country for Keywords Everywhere volumes |
| `KE_MAX_KEYWORDS` | `20` (0–99) | Keyword ideas sent to Keywords Everywhere per search, on top of the keyword itself (1 credit each) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset | OAuth client for the My channel tab |
| `ENABLE_REVENUE` | `0` | `1` also requests revenue metrics (YouTube Partner Program channels only) |
| `ANTHROPIC_API_KEY` | unset (AI Studio off) | Anthropic API key for AI Studio |
| `AI_MODEL` | `claude-opus-5-5` | Claude model ID used by AI Studio |
| `AI_ENABLED` | unset | `1` turns AI Studio on without `ANTHROPIC_API_KEY`, using the Anthropic SDK's own credential lookup |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset | Telegram alert delivery (both are needed) |
| `ALERT_WEBHOOK_URL` | unset | Discord, Slack or generic JSON webhook for alerts |
| `RANK_MAX_CHECKS_PER_DAY` | `20` (0–1000) | Rank checks (manual plus automatic) allowed in any rolling 24 hours; `0` turns rank checks off |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Listen address. Anything other than `127.0.0.1`, `localhost` or `::1` requires `APP_PASSWORD` |
| `APP_PASSWORD` | unset | Password for the whole app (HTTP Basic auth, any username) |
| `PUBLIC_URL` | `http://localhost:PORT` | Public address, used for the Google sign-in redirect |
| `DATA_DIR` | `data` | Where tracked channels, snapshots, rankings, alerts and your Google sign-in are stored |
| `DISABLE_SCHEDULER` | unset | `1` stops the background jobs: daily tracking snapshots and automatic rank checks (manual refreshes still work, and alerts then come only from those) |

The Anthropic SDK may also read its own variables from the environment (for example `ANTHROPIC_BASE_URL`); TubeScout does not set them.

## Features

| Tab | What you get |
|---|---|
| **Competitors** | Head-to-head table (best value in each column highlighted), bar charts, outlier videos across all competitors, shared title keywords, best upload day and hour, which title styles work, popular tags, CSV export, and one-click "Track these channels daily" |
| **Channel deep dive** | KPIs, breakout videos, Shorts vs long-form, schedule, title keywords and patterns, channel keywords, tags, and a sortable table of every analyzed video with CSV export |
| **Keyword research** | **Search demand:** autocomplete strength, Google monthly searches with CPC, a YouTube-search Trends chart, and rising related searches. **Keyword ideas:** questions and long-tail phrases with CSV export. **Competition:** opportunity, demand and competition scores, the top-ranking videos, the channels ranking for the keyword, related keywords and tags. Region and language options (e.g. `IN` + Hindi) |
| **AI Studio** | Claude-written titles (each scored 0–100 with the reasons shown), description with tags and hashtags, video ideas that cite their evidence, and script outlines |
| **Audit** | Video SEO score and grade with a checklist (official YouTube rules marked separately from heuristics), and a channel audit with weighted sections, prioritized recommendations and a per-video table with CSV export |
| **Rankings** | Daily YouTube search position of a channel's videos for a keyword (up to 30 keyword/channel/region combinations): current and best position, changes since the last check and over ~7 days, a history chart, and who holds the top 3 |
| **Tracking** | Daily snapshots of up to 25 channels: subscriber and view growth charts, changes over 24 hours, 7 days and 30 days, **Trending now** (videos currently gaining views far faster than their channel's norm), and new uploads |
| **Alerts** | A feed of new uploads, breakout videos, subscriber milestones and ranking changes, with per-type switches, thresholds, and optional Telegram / Discord / Slack / webhook delivery |
| **My channel** | Views, watch hours, average view duration, average % viewed, net subscribers, likes, comments and shares compared with the previous period; daily charts; traffic sources; **the YouTube search terms that brought viewers**; top videos with **audience-retention curves**; age and gender; top countries; revenue (for monetized channels, opt-in) |

### AI Studio (Claude)

Four generators that start from real YouTube data, not a blank prompt:

- **Titles:** 5, 10, 15 or 20 options for a topic. Each prompt includes YouTube autocomplete searches for your keyword (or the topic, if you give no keyword), your competitors' outlier videos (videos that beat their own channel's typical views), and the title patterns that over-perform in that sample. Each title gets a 0–100 score, with the breakdown shown. The score is the share of points earned among the checks that apply:
  - fits in about 70 characters (heuristic; YouTube's hard limit is 100): 25 points
  - contains the target keyword, as a phrase or every word of it: 30 points, only when you give a keyword
  - uses a title pattern with at least 1.15× lift in your competitor sample: 20 points, only when the sample has such a pattern
  - not mostly ALL CAPS: 10 points
  - not clickbait-only (says what the viewer gets): 15 points. Hype phrases next to a real subject are pointed out but not penalized.
- **Description & tags:** a description written to put your keyword in roughly the first 150 characters (the part shown before "...more"; a heuristic), plus tags and up to 5 hashtags. Tags are trimmed to YouTube's 500-character tag limit, where commas and the quotes around multi-word tags count. The description is kept within YouTube's 5,000-byte limit. TubeScout never adds links or timestamps of its own: lines with timestamps or only hashtags, and sentences with links you did not supply, are removed from Claude's text. Your own chapters and links are appended exactly as typed, and your chapters are checked against YouTube's rules (first at 00:00, at least 3 in ascending order, each at least 10 s).
- **Video ideas:** 8 ideas (the API accepts `count` up to 12), each citing its evidence: linked competitor outlier videos and autocomplete searches (seeded with your keyword, or else the competitors' most common title keyword). It needs a keyword or competitor channels.
- **Script outline:** hook, beats, call to action and retention tips for a target length. `[ADD: ...]` marks where you need to add your own facts.

The competitor field takes up to 8 channels. Leave it empty to use your tracked channels (the first 5). Competitor titles and autocomplete text go to Claude as clearly delimited, untrusted data, never as instructions. In demo mode the competitor data is synthetic, and the results say so.

What is sent to Anthropic: the text you type, and for Titles and Ideas also the competitor video titles and stats and the autocomplete suggestions used as evidence.

### Audit (video SEO score and channel audit)

- **Video audit:** paste a video URL (watch, youtu.be, Shorts, embed, live) or an 11-character ID, and optionally a target keyword. You get a 0–100 SEO score and an A–F grade (A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40), the video's stats, an outlier score (views ÷ the median views of the channel's 50 most recent uploads of the same format), and a checklist with failed checks first. Each check shows its points, a fix and a badge:
  - **Official rule** marks a documented YouTube requirement: a chapter list starts at 0:00, has at least 3 timestamps in ascending order, and each chapter is at least 10 s long; tags total at most 500 characters, counted the API's way; with more than 60 hashtags YouTube ignores all of them.
  - **Heuristic** marks a TubeScout rule of thumb: title length, keyword placement, description length, having chapters at all, tags, hashtag count, links and a call to action, HD thumbnail available (a proxy, not proof of a custom thumbnail), captions available (as reported by the API), HD video, and engagement compared with the channel's other uploads of the same format.
  - Only the description's chapter list is checked: TubeScout looks for a block of timestamp lines (one with 0:00, or a time-first list of 2+), so a stray time such as "every Friday at 18:00" or a track length is not mistaken for a chapter.
  - Shorts (3 minutes or less) get Shorts-appropriate checks: no chapters or HD-thumbnail check, a call to action instead of links (links in Shorts descriptions are not clickable), and lower description thresholds.
  - The score is the share of available points earned, so checks that do not apply (no keyword, a Short) are left out rather than failed.
- **Channel audit:** enter an @handle, channel URL or ID, and choose 50, 100 or 200 recent uploads. You get an overall score built from weighted sections: Consistency 20%, Optimization 30%, Packaging 20%, Performance 20%, Channel setup 10%. Each section shows its checks. Recommendations are ordered by how many points fixing them would add, and a sortable table lists each video's SEO score and top issues, with CSV export.
- **Deep links:** `/#tab=audit&video=<id or URL>&keyword=<kw>` or `/#tab=audit&channel=<@handle>`.

Limitations: public data only, so impressions, click-through rate and watch time are not covered (use the My channel tab for your own channel). Automatic chapters and whether a custom thumbnail was set are not visible through the API. Call-to-action detection only recognizes English phrases. Every threshold not marked "Official rule" is a heuristic, not a YouTube rule.

### Rankings (search rank tracking)

- **Add a keyword:** enter a keyword (up to 100 characters), the channel (@handle, URL or channel ID) and, if you want, a 2-letter region. TubeScout checks it right away, then about once a day while the server runs.
- **What a check does:** one YouTube search (`search.list`, relevance order, videos only, up to 50 results). It records every position held by the channel's videos and the top 3 results. The headline position is the channel's best result. "Not in the top 50" means YouTube returned a full page of 50 and none of the channel's videos was on it. YouTube sometimes returns fewer results than requested; if the channel is not among them, the check is shown as unknown ("?") and is never treated as a drop.
- **The table:** current position, the change since the previous check with a definite result, the change since the nearest definite check at least 6.5 days earlier (▲ green = moved up; lower numbers are better), the best position so far, when it was last checked, and **Check now** / **Remove**.
- **The chart:** #1 is at the top, so higher is better. Checks where the channel was not in the top 50 are red × marks on a separate lane; unknown checks are a grey "?".
- **Scheduling and limits:** automatic checks start 30 seconds after the server starts and run hourly for items last checked more than 20 hours ago, oldest first, one at a time. All checks, manual and automatic, count toward `RANK_MAX_CHECKS_PER_DAY` (default 20 per rolling 24 hours, stored in `data/ranks-quota.json`); when it is reached, the API answers 429 and the tab says when the next check is available. A check counts even if the YouTube call then fails. With the default cap and up to 30 items, not every item can be checked every day; items take turns. **Check now** within 15 minutes of the last check is skipped and uses no check, because the YouTube client caches identical searches for 15 minutes. `DISABLE_SCHEDULER=1` turns off automatic checks.
- **Storage:** `data/ranks.json` (up to 30 keyword/channel/region items), `data/rank-<id>.json` (last 400 checks each) and `data/ranks-quota.json`.

Limitations: positions come from the API with your key and no signed-in viewer. YouTube personalizes search with a viewer's history, so read the numbers as a consistent trend, not the exact position every viewer sees. The region is the API's `regionCode`, which limits results to videos viewable in that country; it does not simulate a viewer located there. Only videos are counted, not channels, playlists or shelves. In demo mode, search results are synthetic and identical every day, so positions do not move.

### Alerts

| Alert | When it fires |
|---|---|
| New upload | A channel on the **Tracking** tab published a video or Short after the previous snapshot. The first snapshot of a channel never alerts, and at most 10 uploads alert per snapshot (for example after the server was off for a long time). |
| Breakout | A tracked channel's video is doing at least *N*× better than the channel's typical video **and** gets at least *M* views/day (defaults 3× and 1,000/day; the minimums are 2× and 50/day). Videos at least 7 days old are judged on views gained per day over the last 12+ hours vs the channel's typical daily gain (the Tracking tab's "Trending now" list). Younger videos are judged on total views so far vs the median views of the channel's videos of the same format (Short or regular) that are at least a week old (at least 3 such videos needed). Both need at least 12 hours of snapshots. At most one breakout alert per video per 7 days. |
| Subscriber milestone | A tracked channel passed 1K, 10K, 50K, 100K, 500K, 1M, 5M, 10M … subscribers between two snapshots, based on YouTube's public (rounded) count. Channels that hide their count never trigger it. |
| Ranking | A keyword on the **Rankings** tab entered the top 10, entered or left the top 50, or moved at least *N* places (default 5). Each check is compared with the previous check that had a definite result. The first check of a keyword never alerts. |

The tab label shows the unread count (for example "Alerts (3)") and refreshes it every 60 seconds. You can switch each alert type and each delivery channel on or off and change the thresholds. Each alert is created once, even across restarts (dedupe keys are kept in `data/alerts-seen.json`); the feed (`data/alerts.json`) keeps the newest 500.

**Delivery:** messages are plain text. Discord messages are limited to 2,000 characters and Telegram messages to 4,096. Discord markdown in video titles is escaped and Discord messages never ping anyone. Messages to each destination are queued and paced: about 1 per second, or 1 every 3 seconds for Telegram groups and channels. If a service answers 429 (rate limited), the message is retried once after the wait it asks for, up to 60 seconds; a longer wait is recorded as a failure. Each attempt has a 10-second timeout. The feed shows a new alert right away, and its delivery status fills in once sending finishes. Failed deliveries show on the alert, with secrets removed from the error text. Delivery is at most once: an alert that was still queued when the server stopped is marked as not sent and is not retried. Tokens and webhook URLs stay on the server; the API only reports whether each channel is configured, plus the webhook type and host.

Limitations: alerts use no extra YouTube API quota, because they reuse the Tracking snapshots and Rankings checks. They only fire **while TubeScout is running**, are only as fresh as the latest snapshot or rank check, and see only the newest 30 uploads per channel. In demo mode they are labeled "Demo data" because they come from synthetic channels.

### Chrome extension

The `extension/` folder is a Manifest V3 Chrome extension that shows TubeScout panels on YouTube, served by **your own server**:

- **Video pages** (`/watch`, `/shorts`, `/live`): views/day, outlier score, engagement, SEO score with grade and the top 3 checks to fix (optionally for a target keyword), and the tags with a copy button.
- **Channel pages** (`/@handle`, `/channel/UC…`, `/user/…`): subscribers, median views, uploads/week, engagement and the top 3 outliers.
- **Search results:** autocomplete strength and the top 8 keyword ideas (free autocomplete data only, so it never spends SerpApi or Keywords Everywhere credits).

Install it with **Load unpacked** in `chrome://extensions` (Developer mode). It works with a server on `http://localhost` with no extra setup. Only the extension's background worker talks to your server, and only to five fixed endpoints. See [extension/README.md](extension/README.md) for setup, permissions, privacy and costs.

## How the numbers work (all transparent)

**About search volume:** YouTube does not publish search volume, so no tool has exact YouTube numbers. TubeScout shows real signals and labels each one with its source:
- **Autocomplete strength (0–100)** = 100 × (1 − (prefix length − 1) ÷ keyword length). The prefix is the shortest one at which YouTube's own autocomplete suggests the full keyword. Popular searches appear after only a few letters. A score of 0 means YouTube never suggests it.
- **Keyword ideas** come from YouTube autocomplete for the seed expanded with a–z, question words and modifiers. *Seen in* counts how many of those lookups surfaced the idea.
- **YouTube search interest** comes from Google Trends with the *YouTube Search* property: relative interest from 0 to 100, not counts. The trend figure compares the average of the last 13 data points with the 13 before.
- **Monthly searches** are Google Keyword Planner volumes, which are **Google** searches, not YouTube's. They are useful for gauging overall topic popularity.

**Other metrics:**
- **Outlier score** = video views ÷ the channel's median views for the same format (Shorts and long-form are scored separately).
- **Engagement** = (likes + comments) ÷ views. It is left blank when a video hides its like count, because a comments-only rate is not comparable.
- **Uploads/week** = uploads in the last 90 days ÷ (90/7).
- **Shorts** = videos of 3 minutes or less. The API has no "is Short" flag, so this is an approximation.
- **Keyword demand** = log₁₀(median views/day of the top results + 1) ÷ 5 × 100.
- **Keyword competition** = log₁₀(median subscribers of the ranking channels + 1) ÷ 7 × 100.
- **Keyword opportunity** = 0.6 × demand + 0.4 × (100 − competition).
- **Trending now:** for each video in both the latest snapshot and the newest snapshot at least 12 hours older, views gained per day between the two, divided by the channel's median gain. Videos are listed when they gain at least 2× that median and at least 50 views/day. It needs 12 hours of snapshots; brand-new uploads are left out here because they appear under New uploads.
- **Video SEO score, channel audit, AI title score:** see [Audit](#audit-video-seo-score-and-channel-audit) and [AI Studio](#ai-studio-claude). All thresholds are TubeScout heuristics unless marked as a YouTube rule.

**Data caveats:** YouTube rounds public subscriber counts to 3 significant figures. **Impressions and impressions click-through rate are not available in the YouTube Analytics API**, so check them in YouTube Studio. Analytics dates use Pacific time, and the most recent days fill in with a delay.

## API quota

Since June 1, 2026 the YouTube Data API has granular quotas ([Google's quota cost page](https://developers.google.com/youtube/v3/determine_quota_cost)):

- **Search** (`search.list`) has its own bucket: 1 per call, **100 calls per day** by default. TubeScout uses it for keyword research, rank checks, and finding a channel by a bare name.
- **Everything else** TubeScout calls (`channels.list`, `videos.list`, `playlistItems.list`) costs 1 unit per call from a shared **10,000 units per day**.

Quotas reset at midnight Pacific Time. Your project's actual limits are in the Google Cloud Console. In live mode the page footer shows both counters since the server started. Identical requests are cached in memory for 15 minutes and cost nothing again.

| Action | Units (10,000/day) | Search calls (100/day) |
|---|---|---|
| Analyze one channel (50 videos) | 3–4 (about 2 more per extra 50 videos) | 0 |
| Compare 5 channels | 15–20 | 0 |
| Keyword research (Competition section) | ~2 | 1 |
| Search demand and keyword ideas (autocomplete) | 0 | 0 |
| Track a channel (add + first snapshot) | 3–4 | 0 |
| Daily tracking snapshot | 3 per channel | 0 |
| Rank check | 1 | 1 |
| Video audit (also the extension's video panel) | ~4 | 0 |
| Channel audit (50 uploads) | 3–4 (about 2 more per extra 50 uploads) | 0 |
| AI Studio: Titles, Video ideas | 3–4 per competitor channel | 0 |
| AI Studio: Description & tags, Script outline | 0 | 0 |
| Alerts | 0 (reuses snapshots and rank checks) | 0 |
| Extension: channel panel / search panel | 3–4 / 0 | 0 / 0 |
| My channel | Uses the YouTube Analytics API, plus 2 Data API units per load and 1 per retention curve | 0 |

**Finding a channel by a bare name** (for example `Marques Brownlee`, or a `/c/` URL) instead of an @handle, channel URL or `UC…` ID costs **1 search call** on top of the figures above. A single word without `@` is first tried as a handle (1 unit) and only searched if that fails. Use @handles or URLs to save search calls: with the default 100 per day and the default 20 rank checks, keyword research and name lookups share the remaining 80.

## AI Studio costs

- Each click is one Claude request, billed by Anthropic to your account per input and output token at the rates of the model that answered. The token counts are shown under each result. Requests use effort `medium`, structured JSON output and up to 16,000 output tokens.
- **Refusal fallbacks are on.** Every request uses Anthropic's server-side fallback (`fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta). If Claude declines a request for policy reasons, the API retries it on Anthropic's recommended fallback model within the same call, and the result says "answered by the automatic fallback model". If that also declines, you get an error asking you to rephrase. Anthropic may also bill the declined first attempt (for example when it declined partway through its answer); the token counts shown cover only the attempt that produced the answer. See [Anthropic's refusals and fallback docs](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
- At most 3 generations run at once (a fourth gets a 429). One generation is capped at 5 minutes in total, including up to 2 automatic retries by the SDK.
- Titles and Video ideas also use YouTube API units for the competitor channels (see the table above). Autocomplete is free.
- AI output can be wrong. Scores and the 70/150-character guides are TubeScout heuristics, not YouTube rules. Review everything before publishing.

## Hosting it

By default TubeScout listens only on `127.0.0.1`, so it is private to your computer. To put it on a server, set `HOST=0.0.0.0`, `APP_PASSWORD` (enables a browser password prompt) and `PUBLIC_URL`. TubeScout **refuses to start** on a public address without `APP_PASSWORD`. Every write request must be sent as JSON, so other websites cannot trigger actions in your browser's name (CSRF). Daily snapshots, rank checks and alerts only run while the server is running.

## HTTP API

All endpoints return JSON. POST bodies must be JSON objects sent with `Content-Type: application/json`.

| Area | Endpoints |
|---|---|
| Status | `GET /api/status` (mode, quota and search-call counters, enabled integrations, `capabilities`) |
| Research | `GET /api/channel?q=`, `GET /api/compare?q=&q=…`, `GET /api/keyword?q=&region=`, `GET /api/demand?q=&region=&hl=&lite=` (`lite=1`: free autocomplete signals only, no SerpApi or Keywords Everywhere credits) |
| Tracking | `GET /api/tracked`, `POST /api/tracked {channel}`, `POST /api/tracked/remove {id}`, `POST /api/tracked/refresh` |
| AI Studio | `GET /api/ai/status`, `POST /api/ai/titles`, `/api/ai/description`, `/api/ai/ideas`, `/api/ai/script` |
| Audit | `GET /api/video?id=&keyword=`, `GET /api/audit/channel?q=&max=` (`max` 10–200, default 50) |
| Rankings | `GET /api/ranks`, `POST /api/ranks {keyword, channel, region?}`, `POST /api/ranks/remove {id}`, `POST /api/ranks/check {id?}` (no `id`: check everything due) |
| Alerts | `GET /api/alerts?limit=`, `POST /api/alerts/read {ids} or {all: true}`, `POST /api/alerts/settings`, `POST /api/alerts/test`, `POST /api/alerts/clear` |
| My channel | `GET /api/me`, `GET /api/me/overview?days=`, `GET /api/me/retention?video=`, `GET /auth/google`, `POST /auth/logout` |

## Compared with vidIQ and TubeBuddy

TubeScout covers the research side of those tools: competitor comparison and outlier videos, keyword research with labeled demand signals, daily channel tracking, AI-written titles, descriptions, ideas and outlines grounded in real data, video SEO scores and channel audits, search rank tracking, alerts, private analytics for your own channel, and a Chrome extension. It runs on your own computer with your own API keys, and every score is a documented formula.

It does not have:
- thumbnail A/B testing, or any thumbnail analysis or generation;
- bulk editing or any other change to your videos: it only reads from YouTube;
- a mobile app (the web UI works on phones; the extension is desktop Chrome only);
- an AI coach chat (AI Studio has four single-shot generators);
- real-time views-per-hour tracking (tracking is a daily snapshot);
- comment management;
- exact YouTube search volume (no tool has it; TubeScout shows labeled proxies instead).

## Project layout

```
server.js              HTTP server, routes, auth, .env loader, daily snapshot scheduler
src/youtube.js         YouTube Data API client (input parsing, caching, quota and search-call tracking)
src/analytics.js       Pure metric functions (outliers, keywords, schedule, title patterns, scores)
src/service.js         Channel / compare / keyword orchestration
src/demand.js          Search demand: YouTube autocomplete, Google Trends (SerpApi), Keywords Everywhere
src/tracker.js         Daily snapshots, growth deltas, trending-now detection; emits 'snapshot' events
src/oauth.js           Google OAuth 2.0 sign-in (state check, refresh, revoke)
src/ytanalytics.js     YouTube Analytics API reports for the connected channel
src/ai.js              AI Studio: prompts, grounding, title scoring, description/tag limits (Anthropic SDK)
src/seo.js             Video SEO score and channel audit (pure functions)
src/ranks.js           Search rank tracking: checks, history, daily cap; emits 'ranks' events
src/alerts.js          Alert rules, feed, and paced Telegram / Discord / Slack / webhook delivery
src/features/          Feature modules (AI Studio, Audit, Rankings, Alerts) that plug routes and jobs into server.js
src/store.js           Atomic JSON-file storage (DATA_DIR, default data/)
src/cache.js           TTL cache and concurrency helper
src/demo.js            Synthetic data used when no API key is set
public/                Frontend (vanilla JS, light and dark mode, mobile friendly)
public/features/       Tabs for AI Studio, Audit, Rankings and Alerts
extension/             Chrome extension (Manifest V3); see extension/README.md
test/                  node:test suite (`npm test`)
```

Files in `DATA_DIR`: `tracked.json`, `snap-<channel>.json` (last 400 snapshots each), `oauth.json` (owner-only), `ranks.json`, `rank-<id>.json`, `ranks-quota.json`, `alerts.json`, `alerts-settings.json`, `alerts-seen.json`.

Use of YouTube data must follow the [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service).
