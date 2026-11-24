import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  AlertManager, snapshotAlerts, rankAlert, milestoneCrossed, validateSettingsPatch, normalizeSettings, defaultSettings,
  webhookKind, deliveryConfig, telegramRequest, webhookBody, clip, TELEGRAM_MAX, DISCORD_MAX, MAX_ALERTS,
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
  assert.equal(dc.content, tg.body.text);

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
    const m = new AlertManager({ store: new JsonStore(dir), env, fetch, now: () => T0 + DAY });
    const created = await m.handleSnapshot(event(twoSnapshots()));
    assert.equal(created.length, 3);
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
    const [a] = await m.handleRanks({ itemId: 'x', keyword: 'kw', previous: { position: 30, t: T0 }, current: { position: 5, videoId: 'v', title: 't', t: T0 + DAY } });
    clearTimeout(keepAlive);
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
    const m = new AlertManager({ store: new JsonStore(dir), env: { ALERT_WEBHOOK_URL: 'https://hook.example.org/x' }, demo: true, fetch, now: () => T0 + DAY });
    const created = await m.handleSnapshot(event(twoSnapshots()));
    assert.ok(created.every((a) => a.demo === true));
    assert.ok(fetch.calls.every((c) => c.body.text.startsWith('[Demo data] ') && c.body.alert.demo === true));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
