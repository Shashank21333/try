import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuration, median, normalizeVideo, scoreOutliers, channelSummary, tokenize, keywordStats,
  postingSchedule, titlePatterns, parseChannelKeywords, keywordOpportunity,
} from '../src/analytics.js';
import { parseChannelInput, YouTubeClient } from '../src/youtube.js';
import { DemoClient } from '../src/demo.js';
import { analyzeChannel, compareChannels, researchKeyword } from '../src/service.js';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const vid = (id, { views, days = 10, dur = 'PT10M', title = 'Video', likes = 10, comments = 1, publishedAt } = {}) => ({
  id,
  snippet: { title, channelId: 'UC1', channelTitle: 'Chan', publishedAt: publishedAt || new Date(NOW - days * 86_400_000).toISOString(), liveBroadcastContent: 'none' },
  statistics: { viewCount: String(views), likeCount: String(likes), commentCount: String(comments) },
  contentDetails: { duration: dur },
});

test('parseDuration handles ISO 8601 durations', () => {
  assert.equal(parseDuration('PT45S'), 45);
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT10M'), 600);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(parseDuration('P0D'), 0);
  assert.equal(parseDuration(undefined), 0);
  assert.equal(parseDuration('garbage'), 0);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(median([null, 5, NaN]), 5);
});

test('normalizeVideo computes engagement, age, shorts', () => {
  const v = normalizeVideo(vid('a', { views: 1000, likes: 40, comments: 10, days: 4, dur: 'PT59S' }), NOW);
  assert.equal(v.engagementRate, 0.05);
  assert.equal(v.ageDays, 4);
  assert.equal(v.viewsPerDay, 250);
  assert.equal(v.isShort, true);
  const long = normalizeVideo(vid('b', { views: 0, dur: 'PT3M1S' }), NOW);
  assert.equal(long.isShort, false);
  assert.equal(long.engagementRate, null);
  // 3 minutes exactly still counts as a Short
  assert.equal(normalizeVideo(vid('c', { views: 1, dur: 'PT3M' }), NOW).isShort, true);
});

test('normalizeVideo keeps hidden likes as null', () => {
  const raw = vid('a', { views: 100 });
  delete raw.statistics.likeCount;
  const v = normalizeVideo(raw, NOW);
  assert.equal(v.likes, null);
  assert.equal(v.engagementRate, 0.01); // comments only
});

test('scoreOutliers uses a separate baseline per format', () => {
  const vids = [
    vid('l1', { views: 100 }), vid('l2', { views: 200 }), vid('l3', { views: 1000 }),
    vid('s1', { views: 10_000, dur: 'PT30S' }), vid('s2', { views: 20_000, dur: 'PT30S' }),
  ].map((v) => normalizeVideo(v, NOW));
  const s = Object.fromEntries(scoreOutliers(vids).map((v) => [v.id, v.outlierScore]));
  assert.equal(s.l3, 5); // 1000 / median(100,200,1000)=200
  assert.equal(s.l1, 0.5);
  assert.equal(s.s1, 10_000 / 15_000);
});

test('channelSummary: uploads per week over 90 days and hidden subscribers', () => {
  const vids = scoreOutliers([1, 8, 15, 22, 29, 100].map((d, i) => normalizeVideo(vid(String(i), { views: 100, days: d }), NOW)));
  const ch = { id: 'UC1', snippet: { title: 'X' }, statistics: { subscriberCount: '1000', viewCount: '5', videoCount: '6' } };
  const s = channelSummary(ch, vids, { now: NOW, complete: true });
  assert.equal(s.uploadsPerWeek, 5 / (90 / 7));
  assert.equal(s.subscribers, 1000);
  assert.equal(s.viewsPerSubscriber, 0.1);
  assert.equal(s.daysSinceLastUpload, 1);
  const hidden = channelSummary({ ...ch, statistics: { hiddenSubscriberCount: true } }, vids, { now: NOW, complete: true });
  assert.equal(hidden.subscribers, null);
  assert.equal(hidden.viewsPerSubscriber, null);
  // Truncated sample spanning 29 days: rate is computed over that span
  const partial = channelSummary(ch, vids.slice(0, 5), { now: NOW, complete: false });
  assert.equal(partial.uploadsWindowDays, 29);
  assert.equal(partial.uploadsPerWeek, 5 / (29 / 7));
});

test('tokenize drops stop words and handles non-Latin scripts', () => {
  assert.deepEqual(tokenize("How to Build a PC: Beginner's Guide 2026"), ['build', 'pc', 'beginner', 'guide']);
  assert.deepEqual(tokenize('पैसे कैसे कमाएं'), ['पैसे', 'कैसे', 'कमाएं']);
});

test('keywordStats counts unigrams and bigrams once per video', () => {
  const vids = scoreOutliers(['Budget Phone Review', 'Best Budget Phone 2026', 'Budget phone budget phone', 'Laptop Review']
    .map((t, i) => normalizeVideo(vid(String(i), { views: 100 * (i + 1), title: t }), NOW)));
  const k = Object.fromEntries(keywordStats(vids).map((x) => [x.term, x.count]));
  assert.equal(k['budget phone'], 3);
  assert.equal(k.budget, 3);
  assert.equal(k.review, 2);
  assert.equal(k.laptop, undefined); // only once
});

test('postingSchedule shifts to the viewer timezone', () => {
  // Monday 2026-11-23 20:00 UTC = Tuesday 01:30 in IST (UTC+5:30 => offset -330)
  const v = scoreOutliers([normalizeVideo(vid('a', { views: 5, publishedAt: '2026-11-23T20:00:00Z' }), NOW)]);
  const utc = postingSchedule(v, 0);
  assert.equal(utc.days.find((d) => d.count).day, 'Mon');
  assert.equal(utc.hours.findIndex((h) => h.count), 20);
  const ist = postingSchedule(v, -330);
  assert.equal(ist.days.find((d) => d.count).day, 'Tue');
  assert.equal(ist.hours.findIndex((h) => h.count), 1);
});

test('titlePatterns computes lift only with enough samples', () => {
  const titles = ['5 tips', '7 hacks', '10 ways', 'no number a', 'no number b', 'no number c'];
  const views = [400, 400, 400, 100, 100, 100];
  const vids = scoreOutliers(titles.map((t, i) => normalizeVideo(vid(String(i), { views: views[i], title: t }), NOW)));
  const tp = titlePatterns(vids);
  const numF = tp.features.find((f) => f.key === 'number');
  assert.equal(numF.share, 0.5);
  assert.equal(numF.lift, 4);
  assert.equal(tp.features.find((f) => f.key === 'question').lift, null);
});

test('parseChannelKeywords handles quoted phrases', () => {
  assert.deepEqual(parseChannelKeywords('"tech reviews" gadgets "budget tech"'), ['tech reviews', 'gadgets', 'budget tech']);
  assert.deepEqual(parseChannelKeywords(undefined), []);
});

test('keywordOpportunity scales demand and competition on log scales', () => {
  const vids = [{ viewsPerDay: 99_999, channelSubscribers: 9_999_999, views: 10, ageDays: 10 }];
  const s = keywordOpportunity(vids);
  assert.equal(s.demand, 100);
  assert.equal(s.competition, 100);
  assert.equal(s.opportunity, 60);
  assert.equal(s.smallChannelShare, 0);
});

test('parseChannelInput understands URLs, handles and IDs', () => {
  assert.deepEqual(parseChannelInput('https://www.youtube.com/@MrBeast'), { type: 'handle', value: '@MrBeast' });
  assert.deepEqual(parseChannelInput('youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA'), { type: 'id', value: 'UCX6OQ3DkcsbYNE6H8uQQuVA' });
  assert.deepEqual(parseChannelInput('UCX6OQ3DkcsbYNE6H8uQQuVA'), { type: 'id', value: 'UCX6OQ3DkcsbYNE6H8uQQuVA' });
  assert.deepEqual(parseChannelInput('https://m.youtube.com/user/pewdiepie/videos'), { type: 'username', value: 'pewdiepie' });
  assert.deepEqual(parseChannelInput('@abc'), { type: 'handle', value: '@abc' });
  assert.deepEqual(parseChannelInput('mkbhd'), { type: 'handleOrSearch', value: 'mkbhd' });
  assert.deepEqual(parseChannelInput('Marques Brownlee'), { type: 'search', value: 'Marques Brownlee' });
  assert.equal(parseChannelInput('  '), null);
});

test('YouTubeClient: builds requests, caches, tracks quota, surfaces errors', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.toString());
    if (url.pathname.endsWith('/search')) return { ok: false, status: 403, json: async () => ({ error: { message: 'q', errors: [{ reason: 'quotaExceeded' }] } }) };
    return { ok: true, status: 200, json: async () => ({ items: [{ id: 'UCabc' }] }) };
  };
  const c = new YouTubeClient('KEY', { fetchImpl });
  assert.equal(await c.resolveChannelId('@abc'), 'UCabc');
  assert.equal(await c.resolveChannelId('@abc'), 'UCabc');
  assert.equal(calls.length, 1, 'second call served from cache');
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.get('forHandle'), '@abc');
  assert.equal(u.searchParams.get('key'), 'KEY');
  assert.equal(c.quotaUsed, 1);
  await assert.rejects(c.searchVideos('x'), (e) => e.reason === 'quotaExceeded' && /quota exceeded/i.test(e.message));
});

test('service: analyze, compare and keyword research run end-to-end on demo data', async () => {
  const client = new DemoClient({ now: NOW });
  const a = await analyzeChannel(client, '@techdemo', { now: NOW, max: 50 });
  assert.equal(a.videos.length, 50);
  assert.ok(a.channel.subscribers > 0);
  assert.ok(a.outliers.every((v, i, arr) => i === 0 || arr[i - 1].outlierScore >= v.outlierScore));

  const c = await compareChannels(client, ['@one', '@two', '@one', ''], { now: NOW });
  assert.equal(c.channels.length, 2, 'dedupes and drops blanks');
  assert.equal(c.errors.length, 0);
  assert.ok(c.keywords.length > 0);

  const k = await researchKeyword(client, 'budget phone', { now: NOW });
  assert.ok(k.videos.length > 0);
  assert.ok(k.channels.length > 0);
  assert.ok(k.summary.opportunity >= 0 && k.summary.opportunity <= 100);
  assert.equal(k.videos.length, 25, 'demo search fills all requested results');
  assert.ok(!k.relatedKeywords.some((r) => ['budget', 'phone', 'budget phone'].includes(r.term)), 'query words and phrase excluded');
  await assert.rejects(researchKeyword(client, '  '), /keyword/);
});
