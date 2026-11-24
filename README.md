# TubeScout: YouTube competitor, keyword and channel research

TubeScout is a self-hosted YouTube research tool for creators, similar to vidIQ and TubeBuddy. It combines:

- **Competitor research.** Compare up to 8 channels, find their outlier videos, and see which keywords, title styles and upload times win in your niche.
- **Keyword research with search demand.** Get real YouTube autocomplete signals, Google Trends for YouTube Search, Google search volume, and opportunity scores.
- **Daily tracking.** Growth charts for you and your competitors, videos trending right now, and new uploads.
- **Your own private analytics.** Watch time, retention curves, traffic sources, the search terms that found you, audience age and countries.

It has no npm dependencies and no build step: just Node.js 20+.

## Quick start

```bash
cp .env.example .env        # then fill in the keys you want (only YOUTUBE_API_KEY is needed to start)
npm start                   # http://localhost:3000
```

Without `YOUTUBE_API_KEY`, TubeScout runs in **demo mode**: channel and video numbers are *synthetic* (a yellow banner says so). YouTube autocomplete ideas are real even in demo mode, because they need no key.

## Keys and what each one unlocks

| Key | Unlocks | Cost |
|---|---|---|
| `YOUTUBE_API_KEY` | Real channel, competitor, keyword and tracking data | Free: 10,000 units/day |
| *(none)* | YouTube autocomplete: keyword ideas, questions, autocomplete strength | Free |
| `SERPAPI_KEY` | Google Trends **YouTube Search** interest over 12 months, plus rising and top related searches | SerpApi free plan: 250 searches/month (2 per keyword). Paid plans from $25/month |
| `KE_API_KEY` | Monthly **Google** search volume, CPC and competition for the keyword and its top ideas | Keywords Everywhere credits: 1 per keyword (plans from $7/month billed yearly, 100K credits/year) |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | The **My channel** tab with your private YouTube Analytics | Free |

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

## Features

| Tab | What you get |
|---|---|
| **Competitors** | Head-to-head table (best value in each column highlighted), bar charts, outlier videos across all competitors, shared title keywords, best upload day and hour, which title styles work, popular tags, CSV export, and one-click "Track these channels daily" |
| **Channel deep dive** | KPIs, breakout videos, Shorts vs long-form, schedule, title keywords and patterns, channel keywords, tags, and a sortable table of every analyzed video with CSV export |
| **Keyword research** | **Search demand:** autocomplete strength, Google monthly searches with CPC, a YouTube-search Trends chart, and rising related searches. **Keyword ideas:** questions and long-tail phrases with CSV export. **Competition:** opportunity, demand and competition scores, the top-ranking videos, the channels ranking for the keyword, related keywords and tags. Region and language options (e.g. `IN` + Hindi) |
| **Tracking** | Daily snapshots of up to 25 channels: subscriber and view growth charts, changes over 24 hours, 7 days and 30 days, **Trending now** (videos currently gaining views far faster than their channel's norm), and new uploads |
| **My channel** | Views, watch hours, average view duration, average % viewed, net subscribers, likes, comments and shares compared with the previous period; daily charts; traffic sources; **the YouTube search terms that brought viewers**; top videos with **audience-retention curves**; age and gender; top countries; revenue (for monetized channels, opt-in) |

## How the numbers work (all transparent)

**About search volume:** YouTube does not publish search volume, so no tool has exact YouTube numbers. TubeScout shows real signals and labels each one with its source:
- **Autocomplete strength (0–100)** = 100 × (1 − (prefix length − 1) ÷ keyword length). The prefix is the shortest one at which YouTube's own autocomplete suggests the full keyword. Popular searches appear after only a few letters. A score of 0 means YouTube never suggests it.
- **Keyword ideas** come from YouTube autocomplete for the seed expanded with a–z, question words and modifiers. *Seen in* counts how many of those lookups surfaced the idea.
- **YouTube search interest** comes from Google Trends with the *YouTube Search* property: relative interest from 0 to 100, not counts. The trend figure compares the average of the last 13 data points with the 13 before.
- **Monthly searches** are Google Keyword Planner volumes, which are **Google** searches, not YouTube's. They are useful for gauging overall topic popularity.

**Other metrics:**
- **Outlier score** = video views ÷ the channel's median views for the same format (Shorts and long-form are scored separately).
- **Engagement** = (likes + comments) ÷ views.
- **Uploads/week** = uploads in the last 90 days ÷ (90/7).
- **Shorts** = videos of 3 minutes or less. The API has no "is Short" flag, so this is an approximation.
- **Keyword demand** = log₁₀(median views/day of the top results + 1) ÷ 5 × 100.
- **Keyword competition** = log₁₀(median subscribers of the ranking channels + 1) ÷ 7 × 100.
- **Keyword opportunity** = 0.6 × demand + 0.4 × (100 − competition).
- **Trending now:** views gained per day since the previous snapshot (at least 12 hours earlier), divided by the channel's median gain. Videos are listed when they gain at least 2× that median and at least 50 views/day.

**Data caveats:** YouTube rounds public subscriber counts to 3 significant figures. **Impressions and impressions click-through rate are not available in the YouTube Analytics API**, so check them in YouTube Studio. Analytics dates use Pacific time, and the most recent days fill in with a delay.

## API quota

The YouTube Data API allows 10,000 units per day, and the quota resets at midnight Pacific Time.

| Action | Approx. units |
|---|---|
| Analyze one channel (50 videos) | 3–4 (+100 if it must be found by name search) |
| Compare 5 channels | 15–20 |
| Keyword research | ~102 |
| Tracking snapshot | ~3 per channel per day |
| My channel | Uses the separate YouTube Analytics API (plus 2 Data API units) |

## Hosting it

By default TubeScout listens only on `127.0.0.1`, so it is private to your computer. To put it on a server, set `HOST=0.0.0.0`, `APP_PASSWORD` (enables a browser password prompt) and `PUBLIC_URL`. TubeScout **refuses to start** on a public address without `APP_PASSWORD`. Daily snapshots run while the server is running.

## Project layout

```
server.js            HTTP server, routes, auth, daily snapshot scheduler
src/youtube.js       YouTube Data API client (input parsing, caching, quota tracking)
src/analytics.js     Pure metric functions (outliers, keywords, schedule, title patterns, scores)
src/service.js       Channel / compare / keyword orchestration
src/demand.js        Search demand: YouTube autocomplete, Google Trends (SerpApi), Keywords Everywhere
src/tracker.js       Daily snapshots, growth deltas, trending-now detection
src/oauth.js         Google OAuth 2.0 sign-in (state check, refresh, revoke)
src/ytanalytics.js   YouTube Analytics API reports for the connected channel
src/store.js         Atomic JSON-file storage (data/)
src/demo.js          Synthetic data used when no API key is set
public/              Frontend (vanilla JS, light and dark mode, mobile friendly)
test/                node:test suite (`npm test`)
```

Use of YouTube data must follow the [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service).
