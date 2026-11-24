# Put TubeScout online with Render

This guide turns TubeScout into a normal website, such as `https://tubescout-abcd.onrender.com`, that runs 24 hours a day. Tracking, rank checks and alerts keep working while your computer is off. You need no programming. Everything happens in your web browser and takes about 15 minutes.

The repository already contains the setup file Render needs (`render.yaml`). It tells Render to:

- run one always-on web server in **Singapore**, the closest Render region to India,
- attach a **1 GB disk** that keeps your tracked channels, rankings, alerts and Google sign-in safe across restarts and updates,
- ask you for your **YouTube API key** and a **password** while you set it up (they are never saved in GitHub),
- update the site automatically whenever new code is pushed.

## What it costs

| Item | Price (as listed on Render's pricing page) |
|---|---|
| Render account (the "Hobby" workspace) | $0 per month |
| Web server, plan `0.5c-512mb` (0.5 CPU, 512 MB RAM; Render used to call it **Starter**) | $7 per month |
| Disk, 1 GB at $0.25 per GB per month | $0.25 per month |
| **Total** | **about $7.25 per month** |

The Hobby workspace includes 5 GB of outgoing traffic per month (then $0.15 per GB), which is plenty for one person. Prices are in US dollars and may change. **Check them on <https://render.com/pricing> before you start.** Render bills your card, and your bank converts to rupees. Many Indian cards need **international (online) transactions** switched on in your banking app first.

The YouTube API is free within Google's daily quota. Optional extras (AI Studio, SerpApi, Keywords Everywhere) are billed by those companies, not by Render.

Why not Render's free plan? Free servers go to sleep after 15 minutes without visitors, and they cannot have a disk, so tracking would stop and your data would disappear.

## Before you start

1. **A YouTube Data API key.** Follow [step 1 in the README](README.md#1-youtube-data-api-key). Copy the key (it starts with `AIza`). Tip: in Google Cloud, open the key's settings and under *API restrictions* allow only **YouTube Data API v3**, so the key is useless for anything else.
2. **A password for your site.** Anyone who has it can use TubeScout, spend your API quota and see your channel analytics. Use at least 16 characters, for example four random words with numbers, like `mango-river-7-lantern-42` (make up your own; don't use this example). Save it in your password manager.
3. **A GitHub account** that can see the repository `github.com/Shashank21333/try`. The repository is public.

> **Never put keys or passwords into GitHub files.** The repository is public: anyone can read it. Keys go only into Render's screens, as shown below.

## Step 1: Create your Render account

1. Open <https://dashboard.render.com/register>.
2. Choose **GitHub** and allow Render to use your GitHub account. (Signing up with email also works; Render then asks you to connect GitHub when you pick the repository.)
3. If Render asks for a payment card, add it now. A paid server cannot be created without one.

## Step 2: Create TubeScout from the Blueprint

A *Blueprint* is Render's name for a setup file. TubeScout's is `render.yaml`.

1. In the Render Dashboard, click **New**, then **Blueprint**.
2. In the list of repositories, find **Shashank21333/try** and click **Connect**. If it is not listed, use the option on that page to give Render access to more of your GitHub repositories, then come back.
3. In the form:
   - **Blueprint Name**: `tubescout` (any name is fine).
   - **Branch**: choose **`claude/modest-heisenberg-iu6wbv`**. That is the branch with TubeScout's code and is currently the repository's default branch. If the code is merged into `main` later, you can choose `main` instead. Render deploys whatever is on the branch you pick, now and on every update.
   - **Blueprint Path**: leave it empty (Render uses `render.yaml`).
4. Render shows what it will create: one web service called **tubescout** with a disk. It then asks for two values:
   - **YOUTUBE_API_KEY**: paste your YouTube API key.
   - **APP_PASSWORD**: type the password you chose.

   Do not add spaces before or after either value.
5. Click **Deploy Blueprint**.

**Shortcut for items 1 to 3 above:** open <https://render.com/deploy?repo=https://github.com/Shashank21333/try>. This *Deploy to Render* link sets up the same Blueprint from the repository's default branch, which is currently `claude/modest-heisenberg-iu6wbv`. Then fill in the values as in step 4. Afterwards, check auto-deploy as described in [Updates](#updates-happen-automatically).

Render now installs and starts TubeScout. The first deploy takes a few minutes. Click the **tubescout** service and open **Logs** to follow it. It is ready when the log shows lines like these:

```
TubeScout running at https://tubescout-abcd.onrender.com  (listening on 0.0.0.0:10000)
Live mode: using the YouTube Data API v3.
```

If it says `DEMO MODE` instead, the YouTube key is missing. See [Troubleshooting](#troubleshooting).

## Step 3: Open your site and log in

1. On the **tubescout** service page, click the address at the top, which ends in **`.onrender.com`**. That is your site's address; bookmark it.
2. Your browser asks for a username and password:
   - **Username**: anything (for example your name). TubeScout ignores it.
   - **Password**: your `APP_PASSWORD`.
3. TubeScout opens, just as on your computer. Your browser remembers the login until you close it.

## Step 4 (optional): Connect "My channel" (Google sign-in)

My channel shows your private YouTube Analytics. Render tells TubeScout its own `https://….onrender.com` address, so the sign-in works without extra settings.

1. In Google Cloud, follow [README step 2](README.md#2-my-channel-google-sign-in) (enable *YouTube Analytics API*, set up the *OAuth consent screen* and add yourself as a *Test user*).
2. When you create the **OAuth client ID** (type *Web application*), add this **Authorized redirect URI**, using your own address:

   ```
   https://tubescout-abcd.onrender.com/auth/google/callback
   ```

   It must match exactly: `https`, no extra slash at the end. TubeScout's **My channel** tab shows the exact URI to copy in its setup card.
3. Copy the **Client ID** and **Client secret**.
4. In Render, add them as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (see the next section).
5. After the restart, open **My channel** and click **Connect with Google**.

While your Google Cloud app's consent screen is in **Testing** (the setup above), Google ends the sign-in after **7 days**. When My channel asks you to connect again, just click **Connect with Google** again. Tracking, Rankings and Alerts do not use the Google sign-in, so they keep running either way.

If you later give TubeScout your own domain name, add `PUBLIC_URL` with that address (for example `https://yt.example.com`) and add the matching redirect URI in Google Cloud.

## Add or change keys later

Render asks for values only while you create the Blueprint. To add an optional key or change one later:

1. Render Dashboard → click the **tubescout** service → **Environment** (left menu).
2. Under *Environment Variables*, click **Edit** (if shown), then **Add variable**, or change an existing value.
3. Enter the **Key** (exact name, capital letters) and the **Value**.
4. Open the save menu and choose **Save and deploy**. TubeScout restarts with the new settings in about a minute. (*Save only* keeps the change for the next deploy.)

| Key | What it turns on |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | My channel (your private YouTube Analytics) |
| `ANTHROPIC_API_KEY` | AI Studio (titles, ideas, descriptions, scripts; billed by Anthropic) |
| `SERPAPI_KEY` | Google Trends in Keyword research |
| `KE_API_KEY` | Google search volume, CPC and competition (Keywords Everywhere) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Alerts sent to Telegram |
| `ALERT_WEBHOOK_URL` | Alerts sent to Discord, Slack or another webhook |
| `APP_PASSWORD` | Change your site password (then log in again everywhere, including the Chrome extension) |

How to get each key: see [Keys and what each one unlocks](README.md#keys-and-what-each-one-unlocks). Other settings are listed in [All environment variables](README.md#all-environment-variables). **Do not change `HOST`, `DATA_DIR` or `NODE_VERSION`**; they are set by `render.yaml` and TubeScout needs them as they are.

## Updates happen automatically

Whenever new code is pushed to the branch you chose, Render rebuilds and restarts TubeScout by itself. You don't need to do anything. Your data stays on the disk. Because of the disk, the site is unavailable for a few seconds during each restart. Render stops the old server first and then starts the new one, so the two never write to the disk at the same time.

To check: **tubescout** service → **Settings** → **Auto-Deploy** should say **On Commit**. To update by hand: on the service's **Deploys** page, open **Manual Deploy** → **Deploy latest commit**.

## Use the Chrome extension with your online TubeScout

1. On GitHub, open the repository, pick the same branch, click **Code** → **Download ZIP**, and unzip it.
2. In Chrome, open `chrome://extensions`, switch on **Developer mode** (top right), click **Load unpacked**, and select the `extension` folder from the unzipped files.
3. Click the extension's icon → **Settings** (or, in `chrome://extensions`, *Details* → *Extension options*).
4. **Server URL**: your Render address, for example `https://tubescout-abcd.onrender.com`. **Password**: your `APP_PASSWORD`.
5. Click **Save**. Chrome asks to allow the extension to reach that one website. Click **Allow**.
6. Click **Test connection**. It should show *live* mode.

More details are in [extension/README.md](extension/README.md).

## Your data and backups

- Everything TubeScout saves is on the Render disk, in the folder `/var/data`: tracked channels, daily snapshots, rankings, alerts and your Google sign-in.
- **Render takes an automatic snapshot of the disk every 24 hours and keeps each one for 7 days.** If something goes wrong, open the service → **Disk** and restore a snapshot. Restoring replaces the whole disk, so anything saved after that snapshot is lost.
- To keep your own copy (optional, a little technical): open the service's **Shell** page and run

  ```
  cd /var/data && tar czf /tmp/tubescout-backup.tgz . && wormhole send /tmp/tubescout-backup.tgz
  ```

  Then run `wormhole receive` on your computer (it needs the free [Magic Wormhole](https://magic-wormhole.readthedocs.io/) tool) and type the code it shows. Render's guide: <https://render.com/docs/disks#transferring-files>.

## Troubleshooting

**The deploy failed.** Open the service → **Logs** and read the last red lines.
- `Refusing to listen on 0.0.0.0 without APP_PASSWORD`: the password is missing. Add `APP_PASSWORD` under **Environment** and choose **Save and deploy**.
- An error during `npm ci` (the install step): on the **Deploys** page, open **Manual Deploy** → **Clear build cache & deploy**. If it still fails, copy the log lines for whoever maintains the code.
- A health check failure: TubeScout answers on `/healthz` as soon as it has started. If the logs show it crashed before that, the cause is in the lines just above.

**The browser keeps asking for the password (401).**
- The username can be anything. The password must be exactly `APP_PASSWORD` (capital letters count).
- If you just changed `APP_PASSWORD`, your browser may still send the old one. Close all browser windows, or open the site in a private (incognito) window. Update the password in the Chrome extension's options too.

**A yellow "demo mode" banner, or numbers look made up.** `YOUTUBE_API_KEY` is missing or wrong. Fix it under **Environment** → **Save and deploy**.

**"Quota exceeded" or YouTube errors after heavy use.** Google allows about 10,000 units and 100 searches per day for each API project. The limits reset at midnight Pacific Time, which is 1:30 PM IST (12:30 PM IST from March to early November). Tracking runs once a day and rank checks are capped at 20 per day by default, so normal use fits. To use fewer, track fewer channels, lower `RANK_MAX_CHECKS_PER_DAY`, or use @handles instead of channel names. See [API quota](README.md#api-quota). You can request more quota in Google Cloud.

**Google sign-in says `redirect_uri_mismatch`.** The redirect URI in Google Cloud must be exactly `https://<your-address>.onrender.com/auth/google/callback`. Copy it from the My channel setup card.

**The site is slow from India.** The region is set to Singapore when the service is created and cannot be changed later. A different region would need a new service.

## For the technically curious

- `render.yaml` sets the plan, the region, `npm ci` / `node server.js`, a 1 GB disk mounted at `/var/data`, `DATA_DIR=/var/data`, `HOST=0.0.0.0` and `NODE_VERSION=22`. It also sets `healthCheckPath: /healthz` and auto-deploy on commit, and asks for `YOUTUBE_API_KEY` and `APP_PASSWORD` (`sync: false`). Render provides `PORT` (10000) and `RENDER_EXTERNAL_URL`. TubeScout uses `RENDER_EXTERNAL_URL` for the Google sign-in redirect unless `PUBLIC_URL` is set.
- `/healthz` is the only page that works without the password. It answers `{"ok":true}` and nothing else.
- On shutdown (Render sends `SIGTERM` before each restart), TubeScout stops taking requests, finishes saving data and exits.
- Render documentation: [Blueprint reference](https://render.com/docs/blueprint-spec), [persistent disks](https://render.com/docs/disks), [environment variables](https://render.com/docs/configure-environment-variables), [health checks](https://render.com/docs/health-checks), [regions](https://render.com/docs/regions).
