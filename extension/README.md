# TubeScout for Chrome

A Manifest V3 extension that shows data from **your own** TubeScout server directly on YouTube, the way vidIQ and TubeBuddy do, but without a third-party account.

| YouTube page | Panel shows | Server endpoint |
|---|---|---|
| `/watch?v=…`, `/shorts/…`, `/live/…` | Views per day, outlier score vs the channel's median, engagement rate, SEO score and grade with the 3 checks to fix first (optionally re-scored for a target keyword), the video's tags with a copy button. Buttons: **Track channel**, **Full audit** (opens the Audit tab), **Open dashboard** | `GET /api/video` |
| `/@handle`, `/channel/UC…`, `/user/…` | Subscribers, median views, uploads per week, engagement, top 3 outlier videos. Buttons: **Track channel**, **Open in TubeScout** | `GET /api/channel` |
| `/results?search_query=…` | Autocomplete strength with the prefix that triggers it, top 8 keyword ideas. Button: **Research in TubeScout** | `GET /api/demand` |

On watch pages the panel sits at the top of the recommendations column, or under the video's title and description when the window is too narrow for that column; elsewhere it floats at the top right. A floating panel that would cover a video (for example on Shorts in a narrow window) starts collapsed on that page. Click the header to collapse or expand it (remembered for all pages). It follows YouTube's light or dark theme.

## Install (unpacked)

1. Start TubeScout: `npm start` in the TubeScout folder (it prints `http://localhost:3000`).
2. Open `chrome://extensions`, switch on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. The settings page opens. If your server runs on `http://localhost:3000`, there is nothing to change: you should see "Connected".

Tested in Chromium; other Chromium-based browsers that can load unpacked extensions should work but are untested. After `git pull`, click the reload icon on the extension's card in `chrome://extensions` and reload open YouTube tabs.

## Configure

Open the settings from the toolbar popup (**Settings**) or the slider icon in the panel.

- **Server URL**: where TubeScout runs. `http://localhost:<any port>` and `http://127.0.0.1:<any port>` work out of the box. Any other address (another computer, `https://…`) makes Chrome ask for permission to reach that host when you click **Save**. Access to the previous non-local host is removed when you change it.
- **Password**: only if you set `APP_PASSWORD` on the server. It is sent as HTTP Basic auth (any username).
- **Test connection** checks the URL and password typed in the form, even before you save them (a new non-local host needs **Save** first so Chrome can grant access), and shows live/demo mode, API units used since the server started, enabled integrations, and warns if the server is too old for the video panel.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves the server URL, password and the panel's collapsed state (`chrome.storage.local`, restricted to the extension's own pages and worker). |
| `http://localhost/*`, `http://127.0.0.1/*` | Lets the background service worker call a TubeScout server on this computer. A match pattern without a port matches every port. |
| `https://www.youtube.com/*` (content script) | Shows the panel on YouTube pages. |
| Optional: `http://*/*`, `https://*/*` | Never granted up front. When you save a non-local server URL, the extension asks for that one host only. |

How requests flow: the YouTube page's content script asks the background service worker with a message. The worker only calls five fixed endpoints (`GET /api/status`, `/api/video`, `/api/channel`, `/api/demand`, `POST /api/tracked`) on the configured server, adds the password, and never fetches arbitrary URLs. The password is never given to the YouTube page or the content script. The panel is built with DOM APIs inside a closed Shadow DOM, never with `innerHTML`.

## Privacy

The extension talks only to the server URL you configure. For the YouTube page you are viewing, it sends the video ID, channel handle/ID or search term to that server. There are no analytics, no remote code and no third-party requests. Your server then calls YouTube (the Data API, or the public autocomplete for keywords) exactly as the dashboard does.

## Costs and limits

- **Video and channel panels** use your server's YouTube Data API quota in live mode: a few units per video or channel (the free quota is 10,000 units/day; see the main README's quota table). Results are cached for 5 minutes per tab, and collapsed panels load nothing.
- **Keyword panel** uses YouTube's public autocomplete (no API units). If your server has `SERPAPI_KEY` or `KE_API_KEY` set, `/api/demand` also spends those credits, so the panel waits for a click instead of loading automatically.
- **Demo mode** (no `YOUTUBE_API_KEY` on the server): video and channel numbers are synthetic and the panel says so. Keyword data is real.
- The SEO score and outlier score are TubeScout's heuristics, not YouTube ranking rules; checks that are actual YouTube limits are labeled "YouTube rule".
- YouTube's page structure and its `yt-navigate-finish` event are not a public API. The extension also watches the URL as a fallback and floats the panel if it cannot find the sidebar or the area under the video, but a YouTube redesign can still affect placement.
- Requests to your server time out after 25 seconds, because Chrome stops an extension's background worker when a request gets no response for 30 seconds.
- Only `www.youtube.com` is supported (not `m.youtube.com`, YouTube Music or YouTube Studio).

## Files

```
manifest.json      MV3 manifest
background.js      service worker: settings, allowlisted requests to your server
lib.js             pure helpers (page detection, allowlist, formatting), also unit-tested in Node
content.js         the panel on youtube.com (Shadow DOM)
options.html/.js   settings page;  popup.html/.js  toolbar popup;  status.js  shared connection check
ui.css             styles for the options page and popup
icons/             generated by tools/make-icons.mjs (node extension/tools/make-icons.mjs)
```

Tests: `node --test test/extension.test.js` (manifest checks, helpers, the worker's allowlist).
