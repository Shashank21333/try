import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  AlertManager, snapshotAlerts, rankAlert, milestoneCrossed, validateSettingsPatch, normalizeSettings, defaultSettings,
  webhookKind, deliveryConfig, telegramRequest, webhookBody, discordEscape, clip, retryAfterMs, TELEGRAM_MAX, DISCORD_MAX, MAX_ALERTS,
  PACE_MS, MAX_RATE_LIMIT_WAIT_MS,
} from '../src/alerts.js';
import { create } from '../src/features/alerts.js';
import { JsonStore } from '../src/store.js';
import { channelReport } from '../src/tracker.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-03-10T12:00:00Z');
const tmp = () => mkdtemp(path.join(tmpdir(), 'tubescout-alerts-'));

const vid = (id, publishedAt, views, extra = {}) => ({
  id, title: `Video ${id}`, publishedAt: new Date(publishedAt).toISOString(), views, likes: 0, comments: 0, isShort: false, thumbnail: null, ...extra,
});
const snap = (t, subs, videos) => ({ t, subs, views: 1e6, videoCount: videos.length, videos });
const CHANNEL = { id: 'UCabc123', title: 'Rival Channel' };
const event = (snapshots) => ({ channel: CHANNEL, snapshots, report: channelReport(snapshots) });

// Two daily snapshots: one new upload ("new1"), one breakout ("hot"), and a 10K milestone.
function twoSnapshots() {
  const old = T0 - 30 * DAY;
  const base = ['a', 'b', 'c', 'd'].map((id) => vid(id, old, 10_000));
  const prev = snap(T0, 9_800, [...base, vid('hot', old, 10_000), vid('warm', old, 10_000)]);
  const latest = snap(T0 + DAY, 10_100, [
    vid('new1', T0 + DAY / 2, 100, { isShort: true }), // 200/day: only 2x typical
    ...base.map((v) => ({ ...v, views: v.views + 100 })),
    { ...prev.videos[4], views: 15_000 }, // +5000/day = 50x typical
    { ...prev.videos[5], views: 10_400 }, // +400/day = 4x typical but under 1000/day
  ]);
  return [prev, latest];
}

const response = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? '')),
});
function fakeFetch(handler = () => response(200, { ok: true })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

const TOKEN = '123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const DISCORD_URL = 'https://discord.com/api/webhooks/1234567890/sEcReT-webhook_token';
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX';

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for condition');
}

// ---------- rules ----------

test('first snapshot of a channel never alerts (no back-catalogue spam)', () => {
  const [, latest] = twoSnapshots();
  assert.deepEqual(snapshotAlerts(event([latest])), []);
  assert.deepEqual(snapshotAlerts({ channel: CHANNEL, snapshots: [] }), []);
  assert.deepEqual(snapshotAlerts({}), []);
});

test('new upload: only videos missing from the previous snapshot AND published after it', () => {
  const [prev, latest] = twoSnapshots();
  // An older video that just scrolled into the "latest 30" window must not alert.
  latest.videos.push(vid('scrolled-in', T0 - 2 * DAY, 50));
  const ups = snapshotAlerts(event([prev, latest])).filter((a) => a.type === 'upload');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].videoId, 'new1');
  assert.equal(ups[0].dedupeKey, 'upload:new1');
  assert.equal(ups[0].url, 'https://www.youtube.com/watch?v=new1');
  assert.match(ups[0].title, /New Short from Rival Channel/);
  assert.equal(ups[0].channelTitle, 'Rival Channel');
});

test('breakout: ratio and views/day thresholds from settings', () => {
  const snaps = twoSnapshots();
  const br = snapshotAlerts(event(snaps)).filter((a) => a.type === 'breakout');
  assert.deepEqual(br.map((a) => a.videoId), ['hot']); // "warm" is 4x but only 400/day
  assert.match(br[0].message, /5K views\/day/);
  assert.match(br[0].message, /50\.0×/);
  const loose = { ...defaultSettings(), breakoutMinViewsPerDay: 300 };
  assert.deepEqual(snapshotAlerts(event(snaps), loose).filter((a) => a.type === 'breakout').map((a) => a.videoId).sort(), ['hot', 'warm']);
  const strict = { ...defaultSettings(), breakoutRatio: 60 };
  assert.equal(snapshotAlerts(event(snaps), strict).filter((a) => a.type === 'breakout').length, 0);
});

// A mid-size channel: 29 videos 5+ weeks old with 50K views each, gaining 300/day; daily snapshots.
const HOUR = 3_600_000;
const olds = Array.from({ length: 29 }, (_, i) => vid(`o${i}`, T0 - (i + 5) * 7 * DAY, 50_000));
const grown = (t, gain) => olds.map((v) => ({ ...v, views: v.views + gain * ((t - T0) / DAY) }));
const types = (alerts) => alerts.map((a) => `${a.type}:${a.videoId}`);

test('an ordinary new upload never counts as a breakout (first hours or following days)', () => {
  const s0 = snap(T0, 120_000, olds);
  const s1 = snap(T0 + DAY, 120_100, [vid('new', T0 + DAY - 3 * HOUR, 2000), ...grown(T0 + DAY, 300)]);
  const s2 = snap(T0 + 2 * DAY, 120_200, [vid('new', T0 + DAY - 3 * HOUR, 12_000), ...grown(T0 + 2 * DAY, 300)]);
  const s3 = snap(T0 + 3 * DAY, 120_300, [vid('new', T0 + DAY - 3 * HOUR, 18_000), ...grown(T0 + 3 * DAY, 300)]);
  // Before the fix: an 'upload' and a 'breakout' (53x typical) for the same video in the same snapshot.
  assert.deepEqual(types(snapshotAlerts(event([s0, s1]))), ['upload:new']);
  // Day 2: +10K/day is 33x the old videos' gain, but normal for a video's second day.
  assert.deepEqual(types(snapshotAlerts(event([s0, s1, s2]))), []);
  assert.deepEqual(types(snapshotAlerts(event([s0, s1, s2, s3]))), []);
});

test('a young video far above the channel’s typical video is a breakout, from the next snapshot on', () => {
  const s0 = snap(T0, 120_000, olds);
  const s1 = snap(T0 + DAY, 120_100, [vid('hit', T0 + DAY - 5 * HOUR, 160_000), ...grown(T0 + DAY, 300)]);
  const s2 = snap(T0 + 2 * DAY, 121_000, [vid('hit', T0 + DAY - 5 * HOUR, 400_000), ...grown(T0 + 2 * DAY, 300)]);
  // Same snapshot as its upload alert: one message only.
  assert.deepEqual(types(snapshotAlerts(event([s0, s1]))), ['upload:hit']);
  const noUploads = { ...defaultSettings(), types: { ...defaultSettings().types, upload: false } };
  assert.deepEqual(types(snapshotAlerts(event([s0, s1]), noUploads)), ['upload:hit', 'breakout:hit'], 'upload alerts off: nothing to wait for');
  const [br] = snapshotAlerts(event([s0, s1, s2]));
  assert.equal(`${br.type}:${br.videoId}`, 'breakout:hit');
  assert.equal(br.dedupeKey, 'breakout:hit');
  assert.equal(br.title, 'Breakout video on Rival Channel');
  assert.match(br.message, /already has 400K views after 29 hours, 7\.9× the channel's typical video \(median 50\.6K views across 29 videos at least a week old\)/);
  // Thresholds from settings still apply.
  assert.deepEqual(snapshotAlerts(event([s0, s1, s2]), { ...defaultSettings(), breakoutRatio: 10 }), []);

  // Shorts are compared with Shorts: with fewer than 3 established Shorts there is no fair baseline.
  const short = { ...s2.videos[0], isShort: true };
  assert.deepEqual(snapshotAlerts(event([s0, s1, { ...s2, videos: [short, ...s2.videos.slice(1)] }])), []);
});

test('no breakouts from a forced snapshot minutes after the previous one (less than 12h of history)', () => {
  const s0 = snap(T0, 120_000, olds);
  const s1 = snap(T0 + 10 * 60_000, 120_000, olds.map((v, i) => ({ ...v, views: v.views + (i === 3 ? 20 : 0) })));
  assert.deepEqual(snapshotAlerts(event([s0, s1])), []); // before the fix: 2880x "breakout" for o3
  // Also not when the young-video rule would otherwise apply.
  const s1b = { ...s1, videos: [vid('hit', T0 - 2 * DAY, 400_000), ...s1.videos] };
  assert.deepEqual(snapshotAlerts(event([{ ...s0, videos: [vid('hit', T0 - 2 * DAY, 399_000), ...olds] }, s1b])), []);

  // 13h later the tracker's baseline is the first snapshot and a real jump alerts, with the real time span.
  const s2 = snap(T0 + 13 * HOUR, 120_000, olds.map((v, i) => ({ ...v, views: v.views + (i === 3 ? 20_000 : 150) })));
  const br = snapshotAlerts(event([s0, s1, s2]));
  assert.deepEqual(types(br), ['breakout:o3']);
  assert.match(br[0].message, /gained ~37\.4K views\/day over the last 13 hours \(133\.2× the channel's typical 280\.5\/day\)/);
});

test('breakout on a channel whose videos gain nothing says so instead of "0/day"', () => {
  const s0 = snap(T0, 5_000, olds);
  const s1 = snap(T0 + DAY, 5_000, olds.map((v, i) => ({ ...v, views: v.views + (i === 0 ? 2000 : 0) })));
  const [br] = snapshotAlerts(event([s0, s1]));
  assert.match(br.message, /gained ~2K views\/day over the last 24 hours \(the channel's typical video gains under 1 view\/day\)/);
});

test('subscriber milestones', () => {
  assert.equal(milestoneCrossed(9_800, 10_100), 10_000);
  assert.equal(milestoneCrossed(999, 1_000), 1_000);
  assert.equal(milestoneCrossed(900, 60_000), 50_000); // several crossed: report the highest
  assert.equal(milestoneCrossed(4_990_000, 5_000_000), 5_000_000);
  assert.equal(milestoneCrossed(10_000, 10_000), null); // already there before
  assert.equal(milestoneCrossed(10_100, 9_900), null); // going down
  assert.equal(milestoneCrossed(20_000, 40_000), null); // no milestone between
  assert.equal(milestoneCrossed(null, 10_100), null); // hidden subscriber count
  const ms = snapshotAlerts(event(twoSnapshots())).filter((a) => a.type === 'milestone');
  assert.equal(ms.length, 1);
  assert.equal(ms[0].title, 'Rival Channel passed 10K subscribers');
  assert.equal(ms[0].dedupeKey, 'milestone:UCabc123:10000');
  assert.equal(ms[0].url, 'https://www.youtube.com/channel/UCabc123');
});

test('rank rules: first check, top 10, top 50 in/out, big moves', () => {
  const ev = (prevPos, prevT, curPos, extra = {}) => ({
    itemId: 'r1', keyword: 'budget phone', region: 'US', channelId: 'UCme', channelTitle: 'My Channel',
    previous: { position: prevPos, t: prevT }, current: { position: curPos, videoId: 'vid1', title: 'My video', t: T0 }, ...extra,
  });
  assert.equal(rankAlert(ev(null, null, 3)), null, 'first check never alerts');
  assert.equal(rankAlert({ ...ev(null, null, 3), previous: undefined }), null);

  const top10 = rankAlert(ev(14, T0 - DAY, 8));
  assert.match(top10.title, /^Entered the top 10 for “budget phone”/);
  assert.match(top10.message, /is now #8 in YouTube search \(US\) \(was #14\)/);
  assert.equal(top10.url, 'https://www.youtube.com/watch?v=vid1');
  assert.equal(top10.dedupeKey, `rank:r1:${T0}`);

  assert.match(rankAlert(ev(null, T0 - DAY, 5)).title, /^Entered the top 10/); // unranked -> #5
  assert.match(rankAlert(ev(null, T0 - DAY, 42)).title, /^Entered the top 50/);
  assert.match(rankAlert(ev(51, T0 - DAY, 50)).title, /^Entered the top 50/);
  const out = rankAlert(ev(45, T0 - DAY, null, { current: { position: null, videoId: null, title: null, t: T0 } }));
  assert.match(out.title, /^Dropped out of the top 50/);
  assert.match(out.message, /no longer in the checked results/);
  assert.equal(out.url, 'https://www.youtube.com/results?search_query=budget%20phone');

  assert.match(rankAlert(ev(30, T0 - DAY, 24)).title, /^Up 6 places/);
  assert.match(rankAlert(ev(20, T0 - DAY, 25)).title, /^Down 5 places/);
  assert.equal(rankAlert(ev(20, T0 - DAY, 23)), null, 'move below threshold');
  assert.equal(rankAlert(ev(8, T0 - DAY, 5)), null, 'already top 10, small move');
  assert.match(rankAlert(ev(8, T0 - DAY, 3)).title, /^Up 5 places/, 'move equal to the threshold alerts');
  assert.match(rankAlert(ev(20, T0 - DAY, 23), { ...defaultSettings(), rankMoveThreshold: 3 }).title, /^Down 3 places/);
  assert.equal(rankAlert(ev(null, T0 - DAY, null)), null, 'still unranked');
});

// ---------- manager: dedupe, toggles, persistence ----------

test('dedupe survives a store reload (restart) and the feed keeps alerts newest first', async () => {
  const dir = await tmp();
  try {
    const payload = event(twoSnapshots());
    const m1 = new AlertManager({ store: new JsonStore(dir), now: () => T0 + DAY });
    const first = await m1.handleSnapshot(payload);
    assert.deepEqual(first.map((a) => a.type).sort(), ['breakout', 'milestone', 'upload']);
    for (const a of first) {
      assert.equal(a.read, false);
      assert.ok(a.id && a.createdAt && a.dedupeKey && a.title && a.message && a.url);
      assert.deepEqual(a.deliveries, []);
    }

    // "Restart": a new manager on a new store instance reading the same files.
    const m2 = new AlertManager({ store: new JsonStore(dir), now: () => T0 + DAY + 3600_000 });
    assert.deepEqual(await m2.handleSnapshot(payload), []);
    const { alerts, unread, total } = await m2.list();
    assert.equal(total, 3);
    assert.equal(unread, 3);
    assert.equal(alerts.length, 3);

    // Clearing the feed keeps the dedupe history.
    await m2.clear();
    assert.equal((await m2.list()).total, 0);
    assert.deepEqual(await m2.handleSnapshot(payload), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('breakout alerts at most once per video per 7 days', async () => {
  const dir = await tmp();
  try {
    let now = T0 + DAY;
    const m = new AlertManager({ store: new JsonStore(dir), now: () => now });
    const payload = event(twoSnapshots());
    assert.equal((await m.handleSnapshot(payload)).filter((a) => a.type === 'breakout').length, 1);
    now += 3 * DAY;
    assert.equal((await m.handleSnapshot(payload)).length, 0);
    now += 5 * DAY; // 8 days after the first alert
    const again = await m.handleSnapshot(payload);
    assert.deepEqual(again.map((a) => a.type), ['breakout']); // uploads and milestones never repeat
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('disabled alert types create nothing and do not burn the dedupe key', async () => {
  const dir = await tmp();
  try {
    const store = new JsonStore(dir);
    const m = new AlertManager({ store, now: () => T0 + DAY });
    await m.saveSettings({ types: { upload: false, breakout: false } });
    const created = await m.handleSnapshot(event(twoSnapshots()));
    assert.deepEqual(created.map((a) => a.type), ['milestone']);
    await m.saveSettings({ types: { upload: true } });
    assert.deepEqual((await m.handleSnapshot(event(twoSnapshots()))).map((a) => a.type), ['upload']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rank events: first check is silent, duplicates of the same check are deduped', async () => {
  const dir = await tmp();
  try {
    const m = new AlertManager({ store: new JsonStore(dir), now: () => T0 });
    const base = { itemId: 'k1', keyword: 'kw', region: null, channelId: 'UCme', channelTitle: 'Me' };
    assert.deepEqual(await m.handleRanks({ ...base, previous: { position: null, t: null }, current: { position: 4, videoId: 'v', title: 't', t: T0 } }), []);
    const ev = { ...base, previous: { position: 4, t: T0 }, current: { position: 60, videoId: null, title: null, t: T0 + DAY } };
    assert.equal((await m.handleRanks(ev)).length, 1);
    assert.equal((await m.handleRanks(ev)).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('feed is capped at MAX_ALERTS', async () => {
  const dir = await tmp();
  try {
    const store = new JsonStore(dir);
    await store.write('alerts', Array.from({ length: MAX_ALERTS }, (_, i) => ({ id: `old${i}`, read: true })));
    const m = new AlertManager({ store, now: () => T0 + DAY });
    await m.handleSnapshot(event(twoSnapshots()));
    const list = await store.read('alerts', []);
    assert.equal(list.length, MAX_ALERTS);
    assert.notEqual(list[0].id.slice(0, 3), 'old');
    assert.equal(list.at(-1).id, `old${MAX_ALERTS - 4}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- delivery ----------

test('webhook kind detection', () => {
  assert.equal(webhookKind(DISCORD_URL), 'discord');
  assert.equal(webhookKind('https://discordapp.com/api/webhooks/1/abc'), 'discord');
  assert.equal(webhookKind('https://canary.discord.com/api/v10/webhooks/1/abc?thread_id=5'), 'discord');
  assert.equal(webhookKind('https://discord.com.evil.example/api/webhooks/1/abc'), 'generic');
  assert.equal(webhookKind(SLACK_URL), 'slack');
  assert.equal(webhookKind('https://hooks.slack.com.evil.example/services/x'), 'generic');
  assert.equal(webhookKind('https://n8n.example.org/webhook/abc'), 'generic');
  assert.equal(webhookKind('not a url'), null);
});

test('delivery config reports only booleans, kind and host', () => {
  assert.deepEqual(deliveryConfig({}), { telegram: { configured: false }, webhook: { configured: false } });
  assert.deepEqual(deliveryConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-1001234', ALERT_WEBHOOK_URL: DISCORD_URL }), {
    telegram: { configured: true }, webhook: { configured: true, kind: 'discord', host: 'discord.com' },
  });
  assert.match(deliveryConfig({ TELEGRAM_BOT_TOKEN: TOKEN }).telegram.error, /TELEGRAM_CHAT_ID/);
  assert.equal(deliveryConfig({ TELEGRAM_BOT_TOKEN: 'bad/token?x', TELEGRAM_CHAT_ID: '1' }).telegram.configured, false);
  assert.equal(deliveryConfig({ ALERT_WEBHOOK_URL: 'ftp://x.example' }).webhook.configured, false);
  assert.equal(deliveryConfig({ ALERT_WEBHOOK_URL: 'https://user:pw@hook.example.org/x' }).webhook.host, 'hook.example.org');
});

test('payload formatting: Telegram, Discord, Slack, generic', () => {
  const alert = { id: 'a1', type: 'upload', title: 'New video from A & B <C>', message: '“@everyone look” · 5 views', url: 'https://www.youtube.com/watch?v=x1', channelTitle: 'A & B', createdAt: '2026-03-10T12:00:00.000Z', read: false, dedupeKey: 'upload:x1' };

  const tg = telegramRequest(alert, { token: TOKEN, chatId: '-1001234' });
  assert.equal(tg.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.deepEqual(tg.body, { chat_id: -1001234, text: 'New video from A & B <C>\n“@everyone look” · 5 views\nhttps://www.youtube.com/watch?v=x1' });
  assert.equal(telegramRequest(alert, { token: TOKEN, chatId: '@mychannel' }).body.chat_id, '@mychannel');
  assert.equal('parse_mode' in tg.body, false, 'plain text: nothing to escape');

  const dc = webhookBody(alert, 'discord');
  assert.deepEqual(dc.allowed_mentions, { parse: [] });
  assert.equal(dc.content, 'New video from A & B \\<C\\>\n“@everyone look” · 5 views\nhttps://www.youtube.com/watch?v=x1');

  // Discord renders markdown: third-party titles are escaped, our own URL line is not.
  const md = webhookBody({ ...alert, title: '# Big **news**', message: '“[click](https://x.example) __u__ ~~s~~ ||spoiler|| `code` <@123>”\n- item\n> quote', url: 'https://www.youtube.com/watch?v=a_b-c', demo: true }, 'discord');
  assert.equal(md.content, [
    '\\[Demo data\\] \\# Big \\*\\*news\\*\\*',
    '“\\[click\\](https://x.example) \\_\\_u\\_\\_ \\~\\~s\\~\\~ \\|\\|spoiler\\|\\| \\`code\\` \\<@123\\>”',
    '\\- item',
    '\\> quote',
    'https://www.youtube.com/watch?v=a_b-c',
  ].join('\n'));
  assert.equal(discordEscape('1. one\n-# sub\n10 tips (2026)'), '1\\. one\n-\\# sub\n10 tips (2026)');
  // Clipping keeps the URL and never leaves a dangling escape before the ellipsis.
  for (const title of ['A', 'AB']) { // both parities of where the cut lands inside "\*\*\*…"
    const longMd = webhookBody({ ...alert, title, message: '*'.repeat(3000) }, 'discord').content;
    assert.ok(longMd.length <= DISCORD_MAX);
    assert.ok(longMd.endsWith('\\*…\nhttps://www.youtube.com/watch?v=x1'), 'URL kept, no lone backslash before the ellipsis');
  }

  const sl = webhookBody(alert, 'slack');
  assert.deepEqual(sl, { text: 'New video from A &amp; B &lt;C&gt;\n“@everyone look” · 5 views\n<https://www.youtube.com/watch?v=x1>' });

  const gen = webhookBody({ ...alert, demo: true }, 'generic');
  assert.equal(gen.text, `[Demo data] ${tg.body.text}`);
  assert.deepEqual(Object.keys(gen.alert).sort(), ['channelTitle', 'createdAt', 'demo', 'id', 'message', 'title', 'type', 'url']);

  // Length limits.
  const long = { ...alert, message: '😀'.repeat(5000) };
  const tgLong = telegramRequest(long, { token: TOKEN, chatId: '1' }).body.text;
  assert.ok(tgLong.length <= TELEGRAM_MAX && tgLong.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(tgLong), 'no broken surrogate pair');
  assert.ok(webhookBody(long, 'discord').content.length <= DISCORD_MAX);
  assert.equal(clip('abc', 3), 'abc');
  assert.equal(clip('abcd', 3), 'ab…');
});

test('alerts are delivered to every enabled channel; failures are recorded and redacted', async () => {
  const dir = await tmp();
  try {
    const fetch = fakeFetch((url) => {
      if (url.startsWith('https://api.telegram.org/')) return response(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
      return response(204, '');
    });
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', ALERT_WEBHOOK_URL: DISCORD_URL };
    const m = new AlertManager({ store: new JsonStore(dir), env, fetch, now: () => T0 + DAY, sleep: async () => {} });
    const created = await m.handleSnapshot(event(twoSnapshots()));
    assert.equal(created.length, 3);
    // In the feed right away, delivery still queued.
    for (const a of (await m.list()).alerts) assert.deepEqual(a.deliveries, [{ channel: 'telegram', pending: true }, { channel: 'discord', pending: true }]);
    await m.idle();
    assert.equal(fetch.calls.length, 6); // 3 alerts x 2 channels
    const discordCalls = fetch.calls.filter((c) => c.url === DISCORD_URL);
    assert.equal(discordCalls.length, 3);
    assert.equal(discordCalls[0].init.method, 'POST');
    assert.equal(discordCalls[0].init.headers['Content-Type'], 'application/json');
    assert.ok(discordCalls[0].init.signal instanceof AbortSignal, 'requests have a timeout');
    for (const a of (await m.list()).alerts) {
      assert.deepEqual(a.deliveries.map((d) => [d.channel, d.ok]).sort(), [['discord', true], ['telegram', false]]);
      assert.match(a.deliveries.find((d) => d.channel === 'telegram').error, /chat not found/);
    }

    // Turning a channel off in settings stops sends to it.
    await m.saveSettings({ delivery: { telegram: false } });
    fetch.calls.length = 0;
    await m.handleRanks({ itemId: 'x', keyword: 'kw', previous: { position: 30, t: T0 }, current: { position: 5, videoId: 'v', title: 't', t: T0 + DAY } });
    await m.idle();
    assert.deepEqual(fetch.calls.map((c) => c.url), [DISCORD_URL]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('network errors and timeouts never throw and never leak secrets', async () => {
  const dir = await tmp();
  try {
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', ALERT_WEBHOOK_URL: SLACK_URL };
    const fetch = async (url, init) => {
      if (url.includes('telegram')) throw new TypeError(`request to ${url} failed`, { cause: { code: 'ECONNRESET' } });
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    };
    const m = new AlertManager({ store: new JsonStore(dir), env, fetch, now: () => T0 + DAY, timeoutMs: 30 });
    const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout timers are unref'd; keep the test process alive
    await m.handleRanks({ itemId: 'x', keyword: 'kw', previous: { position: 30, t: T0 }, current: { position: 5, videoId: 'v', title: 't', t: T0 + DAY } });
    await m.idle();
    clearTimeout(keepAlive);
    const [a] = (await m.list()).alerts;
    const tg = a.deliveries.find((d) => d.channel === 'telegram');
    const sl = a.deliveries.find((d) => d.channel === 'slack');
    assert.equal(tg.ok, false);
    assert.match(tg.error, /\[redacted\].*ECONNRESET/);
    assert.ok(!tg.error.includes(TOKEN));
    assert.equal(sl.ok, false);
    assert.match(sl.error, /No response within 30ms/);
    const stored = JSON.stringify(await new JsonStore(dir).read('alerts', []));
    assert.ok(!stored.includes(TOKEN) && !stored.includes('XXXXSECRETXXXX'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** Fake clock: sleep() advances now() and records how long each wait was. */
function fakeClock(start = T0 + DAY) {
  const c = { t: start, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}
const rankEvent = (i) => ({ itemId: `k${i}`, keyword: `kw ${i}`, previous: { position: 30, t: T0 }, current: { position: 5, videoId: `v${i}`, title: 't', t: T0 + DAY } });
const withHeaders = (res, headers) => ({ ...res, headers: new Headers(headers) });

test('delivery is paced per destination: ~1 message/s to a private chat, ~3s to a group', async () => {
  const dir = await tmp();
  try {
    for (const [chatId, gap] of [['42', PACE_MS.telegramPrivate], ['-1001234567890', PACE_MS.telegramGroup], ['@mychannel', PACE_MS.telegramGroup]]) {
      const clock = fakeClock();
      const fetch = fakeFetch(() => response(200, { ok: true, result: {} }));
      const m = new AlertManager({ store: new JsonStore(dir), env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: chatId }, fetch, now: clock.now, sleep: clock.sleep });
      await m.clear();
      for (let i = 0; i < 4; i++) await m.handleRanks({ ...rankEvent(i), itemId: `${chatId}-${i}` });
      await m.idle();
      assert.equal(fetch.calls.length, 4);
      assert.deepEqual(clock.sleeps, [gap, gap, gap], `chat ${chatId}`);
      assert.ok(gap >= 1000 && (gap === PACE_MS.telegramPrivate || gap >= 3000)); // FAQ: 1/s per chat, 20/min per group
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a 429 is waited out (retry_after) and retried once; longer waits fail instead of blocking', async () => {
  const dir = await tmp();
  try {
    const clock = fakeClock();
    let mode = 'once';
    let n = 0;
    const fetch = fakeFetch(() => {
      n++;
      if (mode === 'once' && n === 1) return response(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } });
      if (mode === 'always') return response(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 5 } });
      if (mode === 'flood') return response(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3600 } });
      return response(200, { ok: true, result: {} });
    });
    const m = new AlertManager({ store: new JsonStore(dir), env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' }, fetch, now: clock.now, sleep: clock.sleep });
    await m.handleRanks(rankEvent(1));
    await m.idle();
    assert.equal(fetch.calls.length, 2, 'sent again after the wait');
    assert.deepEqual(clock.sleeps, [7000]);
    assert.deepEqual((await m.list()).alerts[0].deliveries, [{ channel: 'telegram', ok: true }]);

    mode = 'always'; fetch.calls.length = 0; clock.sleeps.length = 0;
    await m.handleRanks(rankEvent(2));
    await m.idle();
    assert.equal(fetch.calls.length, 2, 'only one retry');
    const [d] = (await m.list()).alerts[0].deliveries;
    assert.equal(d.ok, false);
    assert.match(d.error, /Rate limited by Telegram \(HTTP 429\): try again in 5s/);

    // A flood wait of an hour: not waited out; the next queued message is skipped without another request.
    mode = 'flood'; fetch.calls.length = 0; clock.sleeps.length = 0; clock.t += 60_000;
    await m.handleRanks(rankEvent(3));
    await m.handleRanks(rankEvent(4));
    await m.idle();
    assert.equal(fetch.calls.length, 1);
    assert.ok(clock.sleeps.every((ms) => ms <= MAX_RATE_LIMIT_WAIT_MS));
    const [a4, a3] = (await m.list()).alerts;
    assert.match(a3.deliveries[0].error, /try again in 60 min/);
    assert.match(a4.deliveries[0].error, /^Not sent: rate limited, the service asked to wait 60 min/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Discord: retry_after in the body, Retry-After header, and an exhausted X-RateLimit bucket are respected', async () => {
  assert.equal(retryAfterMs(null, { retry_after: 1.234 }), 1234); // Discord: seconds, may have decimals
  assert.equal(retryAfterMs(null, { parameters: { retry_after: 3 } }), 3000); // Telegram ResponseParameters
  assert.equal(retryAfterMs({ headers: new Headers({ 'Retry-After': '30' }) }, null), 30_000); // Slack
  assert.equal(retryAfterMs({ headers: new Headers() }, null), 5000); // no hint: our default

  const dir = await tmp();
  try {
    const clock = fakeClock();
    let n = 0;
    const fetch = fakeFetch(() => {
      n++;
      if (n === 1) return withHeaders(response(429, { message: 'You are being rate limited.', retry_after: 2.5, global: false }), { 'Retry-After': '3' });
      if (n === 2) return withHeaders(response(204, ''), { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '4.2' });
      return withHeaders(response(204, ''), { 'X-RateLimit-Remaining': '4', 'X-RateLimit-Reset-After': '1' });
    });
    const m = new AlertManager({ store: new JsonStore(dir), env: { ALERT_WEBHOOK_URL: DISCORD_URL }, fetch, now: clock.now, sleep: clock.sleep });
    await m.handleRanks(rankEvent(1));
    await m.handleRanks(rankEvent(2));
    await m.idle();
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(clock.sleeps, [2500, 4200]); // the body's retry_after, then the bucket reset (longer than our 1.1s pace)
    assert.ok((await m.list()).alerts.every((a) => a.deliveries[0].ok));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a slow destination never delays the in-app feed or the other destination', async () => {
  const dir = await tmp();
  try {
    let release;
    const hung = new Promise((r) => { release = r; });
    const fetch = fakeFetch(async (url) => {
      if (url === SLACK_URL) { await hung; return response(200, 'ok'); }
      return response(200, { ok: true, result: {} });
    });
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', ALERT_WEBHOOK_URL: SLACK_URL };
    const m = new AlertManager({ store: new JsonStore(dir), env, fetch, now: () => T0 + DAY, sleep: async () => {} });
    const created = await m.handleSnapshot(event(twoSnapshots())); // resolves although Slack has not answered
    assert.equal(created.length, 3);
    assert.equal((await m.handleRanks(rankEvent(1))).length, 1, 'later events are not stuck behind delivery');
    await waitFor(async () => fetch.calls.filter((c) => c.url.includes('telegram')).length === 4);
    const feed = (await m.list()).alerts;
    assert.equal(feed.length, 4);
    await waitFor(async () => (await m.list()).alerts.every((a) => a.deliveries.find((d) => d.channel === 'telegram').ok));
    assert.ok((await m.list()).alerts.every((a) => a.deliveries.find((d) => d.channel === 'slack').pending));
    release();
    await m.idle();
    assert.ok((await m.list()).alerts.every((a) => a.deliveries.every((d) => d.ok)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deliveries still queued when the server stopped are marked as not sent on the next start', async () => {
  const dir = await tmp();
  try {
    const store = new JsonStore(dir);
    await store.write('alerts', [
      { id: 'a1', type: 'upload', title: 't', deliveries: [{ channel: 'telegram', ok: true }, { channel: 'discord', pending: true }] },
      { id: 'a2', type: 'upload', title: 't', deliveries: [] },
    ]);
    const m = new AlertManager({ store: new JsonStore(dir) });
    await m.idle();
    const [a1, a2] = (await m.list()).alerts;
    assert.deepEqual(a1.deliveries, [{ channel: 'telegram', ok: true }, { channel: 'discord', ok: false, error: 'Not sent: the server stopped before this alert was delivered' }]);
    assert.deepEqual(a2.deliveries, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- settings ----------

test('settings validation', () => {
  const s = validateSettingsPatch({ breakoutRatio: 4.5, types: { rank: false }, delivery: { webhook: false } });
  assert.equal(s.breakoutRatio, 4.5);
  assert.equal(s.types.rank, false);
  assert.equal(s.types.upload, true, 'partial update keeps the rest');
  assert.equal(s.delivery.webhook, false);
  assert.equal(validateSettingsPatch({ rankMoveThreshold: '7' }).rankMoveThreshold, 7);

  const rejects = (patch, re) => assert.throws(() => validateSettingsPatch(patch), (e) => e.status === 400 && re.test(e.message));
  rejects(null, /JSON object/);
  rejects([], /JSON object/);
  rejects({ nope: 1 }, /Unknown setting/);
  rejects({ breakoutRatio: 1 }, /between 2 and 1000/);
  rejects({ breakoutRatio: 'abc' }, /must be a number/);
  rejects({ breakoutMinViewsPerDay: 10 }, /between 50/);
  rejects({ rankMoveThreshold: 2.5 }, /whole number/);
  rejects({ rankMoveThreshold: Infinity }, /must be a number/);
  rejects({ types: { upload: 'yes' } }, /true or false/);
  rejects({ types: { spam: true } }, /Unknown alert type/);
  rejects({ delivery: { email: true } }, /Unknown delivery channel/);
  rejects({ types: true }, /must be an object/);
  rejects({ __proto__: { x: 1 }, toString: 1 }, /Unknown setting/);

  // Stored garbage falls back to defaults instead of breaking alerts.
  const n = normalizeSettings({ breakoutRatio: -5, rankMoveThreshold: 9, types: 'x', extra: true });
  assert.equal(n.breakoutRatio, 3);
  assert.equal(n.rankMoveThreshold, 9);
  assert.deepEqual(n.types, defaultSettings().types);
  assert.deepEqual(normalizeSettings(null), defaultSettings());
});

// ---------- feature module (routes + events) ----------

function makeCtx(dir, env = {}) {
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  return {
    env, DEMO: false, store: new JsonStore(dir), events: new EventEmitter(), log: () => {},
    meta: () => ({ mode: 'live' }), httpError,
    readJson: async (req) => req.body ?? {},
    intParam: (v, def, lo, hi) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def; },
  };
}

test('routes: GET never returns secrets; read, settings, clear and test work', async () => {
  const dir = await tmp();
  try {
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '987654321', ALERT_WEBHOOK_URL: DISCORD_URL };
    const ctx = makeCtx(dir, env);
    const { routes } = create(ctx);
    const get = (qs = '') => routes['GET /api/alerts'](new URL(`http://localhost/api/alerts${qs}`));
    const post = (key, body) => routes[`POST /api/alerts/${key}`](new URL(`http://localhost/api/alerts/${key}`), { body });

    let d = await get();
    const text = JSON.stringify(d);
    for (const secret of [TOKEN, '987654321', 'sEcReT-webhook_token', DISCORD_URL]) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.deepEqual(d.delivery, { telegram: { configured: true }, webhook: { configured: true, kind: 'discord', host: 'discord.com' } });
    assert.deepEqual(d.settings, defaultSettings());
    assert.equal(d.unread, 0);
    assert.deepEqual(d.meta, { mode: 'live' });

    // Events -> feed. Turn delivery off so the test makes no network calls.
    await post('settings', { delivery: { telegram: false, webhook: false } });
    ctx.events.emit('snapshot', event(twoSnapshots()));
    await waitFor(async () => (await get()).unread === 3);
    ctx.events.emit('snapshot', { broken: true }); // malformed events are ignored, not thrown
    ctx.events.emit('ranks', null);

    d = await get('?limit=2');
    assert.equal(d.alerts.length, 2);
    assert.equal(d.total, 3);
    const r = await post('read', { ids: [d.alerts[0].id] });
    assert.equal(r.unread, 2);
    assert.equal((await post('read', { all: true })).unread, 0);
    await assert.rejects(post('read', {}), (e) => e.status === 400);
    await assert.rejects(post('read', { ids: [1, 2] }), (e) => e.status === 400);

    await assert.rejects(post('settings', { breakoutRatio: 0 }), (e) => e.status === 400);
    assert.equal((await post('settings', { breakoutRatio: 5 })).settings.breakoutRatio, 5);
    assert.equal((await get()).settings.breakoutRatio, 5);

    assert.deepEqual(await post('clear', {}), { ok: true });
    assert.equal((await get()).total, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('test message goes to every configured channel (even if toggled off), with a cooldown', async () => {
  const dir = await tmp();
  try {
    let now = T0;
    const fetch = fakeFetch((url) => (url.includes('telegram') ? response(200, { ok: true, result: {} }) : response(200, 'ok')));
    const m = new AlertManager({ store: new JsonStore(dir), env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', ALERT_WEBHOOK_URL: SLACK_URL }, fetch, now: () => now });
    await m.saveSettings({ delivery: { telegram: false } });
    const r = await m.sendTest();
    assert.deepEqual(r.results, [{ channel: 'telegram', ok: true }, { channel: 'slack', ok: true }]);
    assert.match(fetch.calls[0].body.text, /TubeScout test alert/);
    assert.match(fetch.calls[1].body.text, /TubeScout test alert/);
    await assert.rejects(m.sendTest(), (e) => e.status === 429);
    now += 6000;
    assert.equal((await m.sendTest()).results.length, 2);
    assert.equal((await m.list()).total, 0, 'test messages are not added to the feed');

    const none = new AlertManager({ store: new JsonStore(dir), env: {}, fetch });
    assert.deepEqual(await none.sendTest(), { results: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('demo mode marks alerts and delivered text as demo data', async () => {
  const dir = await tmp();
  try {
    const fetch = fakeFetch(() => response(200, 'ok'));
    const m = new AlertManager({ store: new JsonStore(dir), env: { ALERT_WEBHOOK_URL: 'https://hook.example.org/x' }, demo: true, fetch, now: () => T0 + DAY, sleep: async () => {} });
    const created = await m.handleSnapshot(event(twoSnapshots()));
    assert.ok(created.every((a) => a.demo === true));
    await m.idle();
    assert.equal(fetch.calls.length, 3);
    assert.ok(fetch.calls.every((c) => c.body.text.startsWith('[Demo data] ') && c.body.alert.demo === true));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
