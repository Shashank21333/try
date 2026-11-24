# TubeScout: YouTube competitor and keyword research

TubeScout is a self-hosted, vidIQ-style research tool for YouTube creators. It pulls public data from the official **YouTube Data API v3** and helps you answer:

- **How do I stack up against my competitors?** Compare up to 8 channels side by side: median views, uploads per week, engagement, Shorts vs long-form, and views per subscriber.
- **What is working for them right now?** Find *outlier videos*, the uploads that beat their own channel's typical views by the widest margin.
- **Which keywords, title styles and upload times win in my niche?**
- **Is this keyword worth making a video on?** See demand, competition and opportunity scores, plus the channels that rank for it.

It has no npm dependencies and no build step: just Node.js 20+.

## Quick start

```bash
git clone <this repo> && cd <repo>
cp .env.example .env        # then paste your API key into .env
npm start                   # http://localhost:3000
```

Without an API key, TubeScout runs in **demo mode** with *synthetic* data (a yellow banner says so), so you can try the interface first.

### Getting a YouTube API key (free)

1. Go to <https://console.cloud.google.com/> and create a project.
2. Open **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.
3. Open **APIs & Services → Credentials → Create credentials → API key**.
4. Optionally restrict the key to *YouTube Data API v3*. Then put it in `.env` as `YOUTUBE_API_KEY=...`.

## Features

| Tab | What you get |
|---|---|
| **Competitors** | Head-to-head table (best value in each column highlighted), bar charts, top outlier videos across all competitors, shared title keywords, best upload day and hour, title patterns that work in the niche, popular tags, CSV export |
| **Channel deep dive** | KPIs, breakout videos, Shorts vs long-form, schedule, title keywords and patterns, channel keywords set in YouTube Studio, tags, and a sortable table of every analyzed video with CSV export |
| **Keyword research** | Opportunity, demand and competition scores, the top-ranking videos with views/day and views ÷ subs, the channels ranking for the keyword (one click adds them to Competitors), related keywords and tags. Optional region code (e.g. `IN`, `US`) |

Channels can be entered as `@handle`, a channel URL (`/@name`, `/channel/UC…`, `/user/…`, `/c/…`), a raw channel ID, or a name.

## How the numbers work

Every metric is a transparent formula, so nothing is a black box:

- **Outlier score** = video views ÷ the channel's median views for the *same format* (Shorts and long-form get separate baselines). `3.0×` means three times the channel's typical video. Videos under 2 days old are left out of outlier lists.
- **Engagement rate** = (likes + comments) ÷ views, averaged per video.
- **Uploads / week** = uploads in the last 90 days ÷ (90 / 7). If only part of the history was fetched and it covers less than 90 days, the span of the fetched videos is used instead.
- **Views / subscriber** = median recent views ÷ subscribers.
- **Shorts** = videos of 3 minutes or less. The API has no "is Short" flag, so a regular video of 3 minutes or less is also counted as a Short.
- **Best day / hour** = median outlier score of the videos uploaded then, in *your browser's* time zone. Slots with fewer than 2 uploads are ignored.
- **Title pattern lift** = median outlier score of titles with the pattern ÷ titles without it (needs at least 3 of each).
- **Keyword scores** are heuristics computed from the top search results, *not* YouTube's own search volume (which the API does not provide):
  - Demand = log₁₀(median views/day + 1) ÷ 5 × 100, so 100K views/day = 100.
  - Competition = log₁₀(median subscribers of the ranking channels + 1) ÷ 7 × 100, so 10M subscribers = 100.
  - Opportunity = 0.6 × demand + 0.4 × (100 − competition).

Data caveats from YouTube itself: public subscriber counts are rounded to 3 significant figures, channels can hide them, and likes can be hidden on individual videos.

## API quota

The default YouTube Data API quota is **10,000 units per day** and resets at midnight Pacific Time.

| Action | Approx. cost |
|---|---|
| Analyze one channel (50 videos) | ~3–4 units (+100 if the channel has to be found by name search) |
| Compare 5 channels | ~15–20 units (3–4 per channel) |
| One keyword search | ~102 units |

Responses are cached in memory for 15 minutes, and the footer shows the units this server has used since it started.

## Project layout

```
server.js            HTTP server (JSON API + static files), .env loader
src/youtube.js       YouTube Data API client: input parsing, caching, quota tracking
src/analytics.js     Pure metric functions (outliers, keywords, schedule, title patterns, scores)
src/service.js       Orchestration for the channel, compare and keyword endpoints
src/demo.js          Synthetic data generator used when no API key is set
public/              Frontend (vanilla HTML/CSS/JS, light and dark mode, mobile friendly)
test/                node:test suite (`npm test`)
```

### API endpoints

- `GET /api/channel?q=@handle&max=50&tz=-330`
- `GET /api/compare?q=@me&q=@rival1&q=@rival2&max=50&tz=-330`
- `GET /api/keyword?q=budget+phone&region=IN&max=25`
- `GET /api/status`

`tz` is the browser's `Date#getTimezoneOffset()` in minutes; for example, IST is `-330`.

## Ideas for next steps

- Save competitor lists and take daily snapshots (e.g. SQLite) to chart subscriber and view growth over time.
- "Connect your channel" through OAuth and the YouTube Analytics API to add CTR, retention and traffic sources for your own channel.
- Autocomplete-based keyword suggestions and AI-generated titles and ideas from outlier videos.
- Thumbnail gallery comparison and alerts when a competitor posts a breakout video.

Use of YouTube data must follow the [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service).
