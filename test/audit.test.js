import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  parseVideoId, parseTimestamp, parseChapters, extractHashtags, tagCharCount, isShouty, cleanKeyword,
  scoreVideo, summarize, gradeFor, failedChecks, longestGapDays, auditChannel, formatBaselines,
  TAGS_MAX_CHARS, HASHTAGS_MAX,
} from '../src/seo.js';
import { create } from '../src/features/audit.js';
import { DemoClient } from '../src/demo.js';
import { JsonStore } from '../src/store.js';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const DAY = 86_400_000;
const LONG_DESC = 'In this video we compare the best budget phone options of the year, test cameras, battery life and speed, '
  + 'and pick a winner for every price range. Subscribe for more honest reviews. Full list: https://example.com/list\n\n'
  + '0:00 Intro\n1:30 Cameras\n4:00 Battery\n7:45 Verdict\n\n#budgetphone #tech';

/** A raw videos.list item; every field can be overridden. */
function rawVideo({
  id = 'abcdefghijk', title = 'Best Budget Phone in 2026: Full Comparison', description = LONG_DESC,
  tags = ['budget phone', 'best phone 2026'], duration = 'PT10M', caption = 'true', definition = 'hd',
  maxres = true, views = 10_000, likes = 400, comments = 50, days = 10, channelId = 'UCchannel000000000000000',
} = {}) {
  const thumbs = { medium: { url: 'https://i.ytimg.com/vi/x/mqdefault.jpg' } };
  if (maxres) thumbs.maxres = { url: 'https://i.ytimg.com/vi/x/maxresdefault.jpg', width: 1280, height: 720 };
  return {
    id,
    snippet: {
      title, description, tags, channelId, channelTitle: 'Chan', thumbnails: thumbs, categoryId: '28',
      defaultAudioLanguage: 'en', publishedAt: new Date(NOW - days * DAY).toISOString(), liveBroadcastContent: 'none',
    },
    statistics: { viewCount: String(views), likeCount: String(likes), commentCount: String(comments) },
    contentDetails: { duration, caption, definition },
  };
}
const check = (r, id) => r.checks.find((c) => c.id === id);

// ---------------------------------------------------------------- input parsing

test('parseVideoId accepts IDs and every common URL form', () => {
  const id = 'dQw4w9WgXcQ';
  for (const input of [
    id, ` ${id} `,
    `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${id}`, `https://music.youtube.com/watch?v=${id}`, `youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`, `https://youtu.be/${id}?si=abc&t=10`, `youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`, `https://youtube.com/shorts/${id}?feature=share`,
    `https://www.youtube.com/embed/${id}?start=5`, `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`, `http://www.youtube.com/v/${id}`,
  ]) assert.equal(parseVideoId(input), id, input);
  for (const bad of ['', null, undefined, 'hello world', 'dQw4w9WgXc', 'dQw4w9WgXcQQ', 'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/@handle', 'javascript:alert(1)', 'https://youtu.be/']) {
    assert.equal(parseVideoId(bad), null, String(bad));
  }
});

test('cleanKeyword trims, collapses whitespace and caps length', () => {
  assert.equal(cleanKeyword('  budget   phone '), 'budget phone');
  assert.equal(cleanKeyword(null), '');
  assert.equal(cleanKeyword('x'.repeat(300)).length, 100);
});

// ---------------------------------------------------------------- chapters

test('parseTimestamp handles m:ss, mm:ss and h:mm:ss', () => {
  assert.equal(parseTimestamp('0:00'), 0);
  assert.equal(parseTimestamp('00:00'), 0);
  assert.equal(parseTimestamp('12:05'), 725);
  assert.equal(parseTimestamp('1:02:03'), 3723);
  assert.equal(parseTimestamp('1:60'), null);
  assert.equal(parseTimestamp('1:61:00'), null);
  assert.equal(parseTimestamp('abc'), null);
});

test('parseChapters accepts valid chapter lists in several formats', () => {
  const ok = parseChapters('Intro text\n0:00 Intro\n1:30 Cameras\n4:00 Battery\n7:45 Verdict', 600);
  assert.equal(ok.valid, true);
  assert.equal(ok.count, 4);
  assert.deepEqual(ok.chapters[1], { start: 90, title: 'Cameras' });
  // 00:00, brackets, bullets, dashes, hour format, timestamp at the end of the line
  assert.equal(parseChapters('[00:00] Start\n• 0:15 - Part one\n(1:00:00) Part two', 4000).valid, true);
  assert.equal(parseChapters('Intro - 0:00\nMiddle (2:00)\nEnd 5:00', 600).valid, true);
  // Prose mentioning a time is not a chapter
  assert.equal(parseChapters('At 3:45 I explain the trick', 600).found, false);
});

test('parseChapters enforces YouTube chapter rules precisely', () => {
  const first = parseChapters('0:05 Intro\n1:00 A\n2:00 B', 600);
  assert.equal(first.valid, false);
  assert.match(first.problems.join(' '), /first timestamp is 0:05; it must be 0:00/);

  const two = parseChapters('0:00 Intro\n1:00 End', 600);
  assert.equal(two.valid, false);
  assert.match(two.problems.join(' '), /at least 3/);

  const order = parseChapters('0:00 Intro\n3:00 B\n2:00 C', 600);
  assert.equal(order.valid, false);
  assert.match(order.problems.join(' '), /ascending order/);

  // 10 seconds is the minimum chapter length: 10 s passes, 9 s fails.
  assert.equal(parseChapters('0:00 A\n0:10 B\n0:20 C', 60).valid, true);
  const short = parseChapters('0:00 A\n0:09 B\n0:30 C', 60);
  assert.equal(short.valid, false);
  assert.match(short.problems.join(' '), /only 9 s long/);

  // The last chapter is checked against the video length.
  assert.equal(parseChapters('0:00 A\n0:20 B\n0:50 C', 60).valid, true);
  assert.match(parseChapters('0:00 A\n0:20 B\n0:55 C', 60).problems.join(' '), /last chapter .* only 5 s/);
  assert.match(parseChapters('0:00 A\n1:00 B\n6:05 C', 360).problems.join(' '), /past the end of the video/);
  // Unknown duration: the last chapter cannot be checked, the rest still is.
  assert.equal(parseChapters('0:00 A\n0:20 B\n0:55 C', 0).valid, true);
});

// ---------------------------------------------------------------- tags, hashtags, caps

test('tagCharCount counts like the YouTube API (commas and quotes)', () => {
  assert.equal(tagCharCount([]), 0);
  assert.equal(tagCharCount(['Foo-Baz']), 7); // example from the API docs
  assert.equal(tagCharCount(['Foo Baz']), 9);
  assert.equal(tagCharCount(['a', 'b']), 3);
  assert.equal(tagCharCount(['a b', 'c']), 7);
});

test('extractHashtags finds distinct hashtags and ignores C#, URL fragments and numbers', () => {
  assert.deepEqual(extractHashtags('#Tech and #tech, #Budget_Phone\n#ελλάδα'), ['tech', 'budget_phone', 'ελλάδα']);
  assert.deepEqual(extractHashtags('I code in C# — see https://x.com/page#section and #1'), []);
});

test('isShouty flags mostly-capital titles and 3+ ALL-CAPS words', () => {
  assert.equal(isShouty('THIS IS THE BEST PHONE EVER'), true);
  assert.equal(isShouty('The NEW iPhone is INSANE and CHEAP'), true);
  assert.equal(isShouty('Why Everyone Is WRONG About the GPU'), false);
  assert.equal(isShouty('OK'), false);
});

// ---------------------------------------------------------------- video checks

test('a well-optimized long-form video passes every check and gets an A', () => {
  const r = scoreVideo(rawVideo(), { keyword: 'budget phone', context: { medianEngagement: 0.04 } });
  const ids = r.checks.map((c) => c.id);
  assert.deepEqual(ids, ['title-length', 'keyword-title', 'keyword-description', 'keyword-tags', 'description-length', 'chapters',
    'tags', 'tags-limit', 'hashtags', 'hashtags-limit', 'links-cta', 'thumbnail-hd', 'captions', 'definition-hd', 'engagement']);
  for (const c of r.checks) {
    assert.equal(c.passed, true, `${c.id}: ${c.detail}`);
    assert.equal(c.points, c.maxPoints);
    assert.ok(['rule', 'heuristic'].includes(c.kind));
    assert.equal(c.fix, undefined);
  }
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
  assert.equal(check(r, 'chapters').kind, 'rule');
  assert.equal(check(r, 'tags-limit').kind, 'rule');
  assert.equal(check(r, 'hashtags-limit').kind, 'rule');
  assert.equal(check(r, 'hashtags').kind, 'heuristic');
});

test('an empty video fails and gets an F, with fix hints on failures', () => {
  const r = scoreVideo(rawVideo({ title: '', description: '', tags: [], caption: 'false', definition: 'sd', maxres: false }));
  assert.equal(r.grade, 'F');
  assert.ok(r.score < 40);
  for (const c of r.checks.filter((x) => !x.passed)) assert.ok(c.fix, c.id);
  assert.equal(check(r, 'tags-limit'), undefined, 'no tag-limit check without tags');
  assert.equal(check(r, 'hashtags-limit'), undefined, 'no hashtag-limit check without hashtags');
  assert.match(check(r, 'description-length').fix, /250/);
  assert.equal(check(r, 'keyword-title'), undefined, 'no keyword checks without a keyword');
  assert.equal(check(r, 'engagement'), undefined, 'no engagement check without channel context');
});

test('title length check', () => {
  assert.equal(check(scoreVideo(rawVideo({ title: 'Phones' })), 'title-length').points, 5);
  assert.equal(check(scoreVideo(rawVideo({ title: 'x'.repeat(70) })), 'title-length').passed, true);
  const long = check(scoreVideo(rawVideo({ title: 'x'.repeat(71) })), 'title-length');
  assert.equal(long.passed, false);
  assert.equal(long.points, 5);
  assert.match(long.detail, /cut off/);
  assert.equal(check(scoreVideo(rawVideo({ title: '   ' })), 'title-length').points, 0);
});

test('keyword checks: title phrase vs words, early vs late in description, tags', () => {
  const kw = (opts, keyword = 'budget phone') => scoreVideo(rawVideo(opts), { keyword });
  assert.equal(check(kw({ title: 'Best Budget Phones Ranked' }), 'keyword-title').points, 10); // plural still matches
  assert.equal(check(kw({ title: 'The Phone on a Budget' }), 'keyword-title').points, 6); // all words, not as phrase
  assert.equal(check(kw({ title: 'Best Laptop Ranked' }), 'keyword-title').points, 0);
  assert.equal(check(kw({ title: 'Budget-Phone tier list' }), 'keyword-title').passed, true); // punctuation folded

  const late = `${'Intro text. '.repeat(20)}Now about the budget phone.`;
  assert.equal(check(kw({ description: late }), 'keyword-description').points, 4);
  assert.equal(check(kw({ description: 'A budget phone guide.' }), 'keyword-description').points, 8);
  assert.equal(check(kw({ description: 'Nothing here' }), 'keyword-description').points, 0);

  assert.equal(check(kw({ tags: ['budget phone 2026'] }), 'keyword-tags').passed, true);
  assert.equal(check(kw({ tags: ['phones'] }), 'keyword-tags').passed, false);
  assert.equal(check(kw({}, '   '), 'keyword-title'), undefined);
});

test('description length check (long-form vs Shorts thresholds)', () => {
  assert.equal(check(scoreVideo(rawVideo({ description: 'x'.repeat(250) })), 'description-length').points, 10);
  assert.equal(check(scoreVideo(rawVideo({ description: 'x'.repeat(120) })), 'description-length').points, 5);
  assert.equal(check(scoreVideo(rawVideo({ description: 'short' })), 'description-length').points, 0);
  const s = check(scoreVideo(rawVideo({ duration: 'PT45S', description: 'x'.repeat(100) })), 'description-length');
  assert.equal(s.maxPoints, 6);
  assert.equal(s.passed, true);
});

test('chapters check: heuristic when missing, official rule when timestamps exist', () => {
  const none = check(scoreVideo(rawVideo({ description: 'x'.repeat(300) })), 'chapters');
  assert.equal(none.passed, false);
  assert.equal(none.kind, 'heuristic');
  assert.match(none.fix, /0:00/);
  const bad = check(scoreVideo(rawVideo({ description: '0:10 Intro\n1:00 A\n2:00 B' })), 'chapters');
  assert.equal(bad.passed, false);
  assert.equal(bad.kind, 'rule');
  assert.match(bad.detail, /must be 0:00/);
  // A 6:00 video whose last timestamp is 6:05 (the demo data edge case)
  const past = check(scoreVideo(rawVideo({ duration: 'PT6M', description: '0:00 A\n1:12 B\n3:40 C\n6:05 D' })), 'chapters');
  assert.equal(past.passed, false);
  assert.match(past.detail, /past the end/);
});

test('tags and the 500-character tag limit', () => {
  const none = scoreVideo(rawVideo({ tags: [] }));
  assert.equal(check(none, 'tags').passed, false);
  assert.match(check(none, 'tags').detail, /minimal role/);
  // 50 tags of 9 characters = 450 + 49 commas = 499 -> within the limit
  const at = check(scoreVideo(rawVideo({ tags: Array.from({ length: 50 }, (_, i) => `tag${String(i).padStart(6, '0')}`) })), 'tags-limit');
  assert.equal(at.passed, true);
  assert.match(at.detail, /499 of 500/);
  // Spaces count as quotes: 50 tags "tag 0000" = 8+2 chars each = 500 + 49 commas = 549 -> over
  const over = check(scoreVideo(rawVideo({ tags: Array.from({ length: 50 }, (_, i) => `tag ${String(i).padStart(4, '0')}`) })), 'tags-limit');
  assert.equal(over.passed, false);
  assert.equal(over.kind, 'rule');
  assert.equal(over.points, 0);
  assert.ok(tagCharCount(Array.from({ length: 50 }, (_, i) => `tag ${String(i).padStart(4, '0')}`)) > TAGS_MAX_CHARS);
});

test('hashtag rule: more than 60 means YouTube ignores all of them', () => {
  const tags = (k) => Array.from({ length: k }, (_, i) => `#topic${i}`).join(' ');
  const r = (description, title) => scoreVideo(rawVideo({ description, ...(title ? { title } : {}) }));
  // 61 hashtags: the official limit fails and the heuristic gives nothing
  const over = r(`${LONG_DESC}\n${tags(HASHTAGS_MAX + 1 - 2)}`); // LONG_DESC already has 2
  assert.equal(check(over, 'hashtags-limit').passed, false);
  assert.equal(check(over, 'hashtags-limit').points, 0);
  assert.equal(check(over, 'hashtags-limit').kind, 'rule');
  assert.match(check(over, 'hashtags-limit').detail, /61 hashtags.*ignores every hashtag/);
  assert.equal(check(over, 'hashtags').points, 0);
  // Exactly 60: within the official limit, but "too many" by the heuristic
  const sixty = r(tags(HASHTAGS_MAX));
  assert.equal(check(sixty, 'hashtags-limit').passed, true);
  assert.equal(check(sixty, 'hashtags').points, 1);
  assert.equal(check(sixty, 'hashtags').kind, 'heuristic');
  assert.match(check(sixty, 'hashtags').detail, /too many/);
  // 15 is fine, 16 is "many"
  assert.equal(check(r(tags(15)), 'hashtags').passed, true);
  assert.equal(check(r(tags(16)), 'hashtags').passed, false);
  // None: heuristic partial credit, and the limit check does not apply
  const none = r('No tags here at all');
  assert.equal(check(none, 'hashtags').points, 1);
  assert.equal(check(none, 'hashtags').kind, 'heuristic');
  assert.equal(check(none, 'hashtags-limit'), undefined);
  // Duplicates count once (case-insensitive); hashtags in the title count too
  assert.equal(check(r('#Tech #tech #TECH'), 'hashtags').detail.startsWith('1 hashtag '), true);
  assert.equal(check(r('plain', 'Phones #tech'), 'hashtags').passed, true);
});

test('links and call to action', () => {
  const both = check(scoreVideo(rawVideo()), 'links-cta');
  assert.equal(both.passed, true);
  const linkOnly = check(scoreVideo(rawVideo({ description: 'Gear: https://example.com/gear' })), 'links-cta');
  assert.equal(linkOnly.points, 2);
  assert.equal(linkOnly.passed, false);
  const ctaOnly = check(scoreVideo(rawVideo({ description: 'Please subscribe!' })), 'links-cta');
  assert.equal(ctaOnly.points, 2);
});

test('HD thumbnail, captions and definition checks', () => {
  const t = check(scoreVideo(rawVideo({ maxres: false })), 'thumbnail-hd');
  assert.equal(t.passed, false);
  assert.match(t.detail, /proxy/);
  assert.match(check(scoreVideo(rawVideo()), 'thumbnail-hd').detail, /does not prove a custom thumbnail/);
  const cap = check(scoreVideo(rawVideo({ caption: 'false' })), 'captions');
  assert.equal(cap.passed, false);
  assert.equal(cap.label, 'Captions available');
  assert.equal(check(scoreVideo(rawVideo({ caption: null })), 'captions'), undefined, 'no flag, no check');
  assert.equal(check(scoreVideo(rawVideo({ definition: 'sd' })), 'definition-hd').passed, false);
  assert.equal(check(scoreVideo(rawVideo({ definition: 'hd' })), 'definition-hd').passed, true);
});

test('engagement vs channel context', () => {
  // 450 / 10,000 = 4.5%
  assert.equal(check(scoreVideo(rawVideo(), { context: { medianEngagement: 0.05 } }), 'engagement').points, 8); // 0.9x
  assert.equal(check(scoreVideo(rawVideo(), { context: { medianEngagement: 0.07 } }), 'engagement').points, 4); // 0.64x
  const low = check(scoreVideo(rawVideo(), { context: { medianEngagement: 0.1 } }), 'engagement');
  assert.equal(low.points, 0);
  assert.match(low.detail, /4\.50% vs 10\.00%/);
  assert.equal(check(scoreVideo(rawVideo({ views: 0 }), { context: { medianEngagement: 0.05 } }), 'engagement'), undefined);
});

test('Shorts get Shorts-appropriate checks', () => {
  const r = scoreVideo(rawVideo({ duration: 'PT45S', description: 'Quick tip. Subscribe for more! https://example.com' }));
  const ids = r.checks.map((c) => c.id);
  assert.ok(!ids.includes('chapters'), 'no chapters requirement for Shorts');
  assert.ok(!ids.includes('thumbnail-hd'));
  const cta = check(r, 'links-cta');
  assert.equal(cta.maxPoints, 2);
  assert.match(cta.detail, /not clickable/);
  assert.equal(check(r, 'captions').maxPoints, 4);
  // 180 s is still a Short, 181 s is long-form
  assert.ok(!scoreVideo(rawVideo({ duration: 'PT3M' })).checks.some((c) => c.id === 'chapters'));
  assert.ok(scoreVideo(rawVideo({ duration: 'PT3M1S' })).checks.some((c) => c.id === 'chapters'));
});

test('grading and score math', () => {
  assert.equal(gradeFor(100), 'A');
  assert.equal(gradeFor(85), 'A');
  assert.equal(gradeFor(84), 'B');
  assert.equal(gradeFor(70), 'B');
  assert.equal(gradeFor(69), 'C');
  assert.equal(gradeFor(55), 'C');
  assert.equal(gradeFor(54), 'D');
  assert.equal(gradeFor(40), 'D');
  assert.equal(gradeFor(39), 'F');
  assert.equal(gradeFor(0), 'F');
  assert.deepEqual(summarize([{ points: 3, maxPoints: 4 }, { points: 0, maxPoints: 4 }]), { score: 38, grade: 'F' });
  assert.deepEqual(summarize([]), { score: 0, grade: 'F' });
  const order = failedChecks([
    { id: 'a', passed: false, points: 4, maxPoints: 5 },
    { id: 'b', passed: true, points: 5, maxPoints: 5 },
    { id: 'c', passed: false, points: 0, maxPoints: 10 },
  ]).map((c) => c.id);
  assert.deepEqual(order, ['c', 'a']);
});

// ---------------------------------------------------------------- channel audit (pure)

const rawChannel = (over = {}) => ({
  id: 'UCchannel000000000000000',
  snippet: { title: 'Chan', description: over.description ?? 'x'.repeat(320), customUrl: '@chan', country: over.country ?? 'US', thumbnails: {} },
  statistics: { subscriberCount: '10000', viewCount: '1000000', videoCount: '40', hiddenSubscriberCount: false },
  brandingSettings: { channel: { keywords: over.keywords ?? '"budget tech" phones' } },
  contentDetails: { relatedPlaylists: { uploads: 'UUchannel000000000000000' } },
});

test('longestGapDays counts gaps between uploads and since the last upload', () => {
  const t = (d) => NOW - d * DAY;
  assert.equal(Math.round(longestGapDays([t(1), t(8), t(30)], { now: NOW, coversWindow: false })), 22);
  assert.equal(Math.round(longestGapDays([t(40), t(45)], { now: NOW, coversWindow: false })), 40);
  assert.equal(Math.round(longestGapDays([t(5), t(10)], { now: NOW, coversWindow: true })), 80); // window start -> t(10)
  assert.equal(longestGapDays([t(200)], { now: NOW }), 90);
  assert.equal(longestGapDays([], { now: NOW }), 90);
});

test('auditChannel builds sections, scores, video rows and impact-ordered recommendations', () => {
  const videos = [];
  for (let i = 0; i < 12; i++) {
    const weak = i % 2 === 1; // every other video: no chapters, thin description, no captions, ALL CAPS
    videos.push(rawVideo({
      id: `vid${String(i).padStart(8, '0')}`,
      title: weak ? 'THIS PHONE IS ABSOLUTELY INSANE' : `Budget Phone Review number ${i}`,
      description: weak ? 'short' : LONG_DESC,
      caption: weak ? 'false' : 'true',
      views: i === 0 ? 100_000 : 10_000 + i * 100,
      days: 3 + i * 5,
      duration: i === 11 ? 'PT40S' : 'PT10M',
    }));
  }
  const a = auditChannel(rawChannel({ description: '', keywords: '' }), videos, { now: NOW, complete: true });
  assert.deepEqual(a.sections.map((s) => s.title), ['Consistency', 'Optimization', 'Packaging', 'Performance', 'Channel setup']);
  for (const s of a.sections) {
    assert.ok(s.score === null || (s.score >= 0 && s.score <= 100));
    for (const c of s.checks) {
      assert.ok(['rule', 'heuristic'].includes(c.kind));
      assert.equal(typeof c.passed, 'boolean');
      assert.ok(c.points <= c.maxPoints);
    }
  }
  const sec = (t) => a.sections.find((s) => s.title === t);
  const chk = (t, id) => sec(t).checks.find((c) => c.id === id);
  assert.equal(chk('Consistency', 'last-upload').passed, true);
  assert.match(chk('Optimization', 'chapters-share').detail, /\(6 of 11\)/);
  assert.equal(chk('Packaging', 'all-caps').passed, false);
  assert.match(chk('Packaging', 'all-caps').detail, /50%/);
  assert.equal(chk('Channel setup', 'channel-keywords').passed, false);
  assert.equal(chk('Channel setup', 'channel-description').passed, false);
  assert.equal(chk('Performance', 'format-mix').info, true);
  assert.equal(chk('Performance', 'format-mix').maxPoints, 0);
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.equal(a.grade, gradeFor(a.score));

  assert.equal(a.videos.length, 12);
  const v0 = a.videos[0];
  assert.deepEqual(Object.keys(v0).sort(), ['grade', 'id', 'isShort', 'outlierScore', 'publishedAt', 'seoScore', 'title', 'topIssues', 'views'].sort());
  assert.ok(v0.outlierScore > 5);
  const weakRow = a.videos[1];
  assert.ok(weakRow.seoScore < v0.seoScore);
  assert.ok(weakRow.topIssues.length > 0 && weakRow.topIssues.length <= 3);
  // Chapters and description length both lose 10 points, so they lead the list
  assert.deepEqual(weakRow.topIssues.slice(0, 2).sort(), ['Chapters', 'Description length']);

  assert.ok(a.recommendations.length >= 4);
  assert.ok(a.recommendations.every((r) => typeof r === 'string' && r.length > 20));
  // ALL-CAPS (6 of 18 Packaging points lost at 20% weight) outranks channel keywords (3 of 9 at 10%)
  const caps = a.recommendations.findIndex((r) => /capitals/.test(r));
  const kw = a.recommendations.findIndex((r) => /channel keywords/.test(r));
  assert.ok(caps >= 0 && kw >= 0 && caps < kw, a.recommendations.join('\n'));
  assert.equal(chk('Optimization', 'chapters-share').passed, true); // 55% >= 50%
  assert.ok(a.recommendations.some((r) => /Expand 6 thin descriptions/.test(r)), a.recommendations.join('\n'));
  // Example titles are not repeated
  assert.ok(a.recommendations.some((r) => /such as "THIS PHONE IS ABSOLUTELY INSANE"\. /.test(r)), a.recommendations.join('\n'));
  // The channel's history starts 58 days ago with 5-day gaps: no 90-day "gap" before the first upload
  assert.equal(chk('Consistency', 'longest-gap').passed, true);
  assert.match(chk('Consistency', 'longest-gap').detail, /: 5 days/);
});

test('auditChannel handles a channel without uploads', () => {
  const a = auditChannel(rawChannel(), [], { now: NOW, complete: true });
  assert.equal(a.videos.length, 0);
  assert.equal(a.sections.find((s) => s.title === 'Optimization').score, null);
  assert.equal(a.sections.find((s) => s.title === 'Consistency').checks[0].passed, false);
  assert.ok(a.recommendations.includes('Publish your first video.'));
});

test('formatBaselines splits medians by format', () => {
  const b = formatBaselines([
    { isShort: true, views: 100, engagementRate: 0.1 }, { isShort: false, views: 10, engagementRate: null },
    { isShort: false, views: 30, engagementRate: 0.02 },
  ]);
  assert.equal(b.short.medianViews, 100);
  assert.equal(b.long.medianViews, 20);
  assert.equal(b.long.medianEngagement, 0.02);
  assert.equal(b.long.count, 2);
});

// ---------------------------------------------------------------- HTTP handlers via create(ctx)

const httpError = (status, message) => Object.assign(new Error(message), { status });
const intParam = (v, def, lo, hi) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def; };

async function makeCtx(client = new DemoClient()) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tubescout-audit-'));
  return {
    dir,
    ctx: {
      env: {}, DEMO: true, client, store: new JsonStore(dir), tracker: null, oauth: null, channelAnalytics: null,
      events: new EventEmitter(), meta: () => ({ mode: 'demo', quotaUsedSinceStart: client.quotaUsed }),
      readJson: async () => ({}), httpError, intParam, regionParam: () => undefined, log: () => {},
    },
  };
}
const call = (routes, key, params) => routes[key](new URL(`http://localhost${key.split(' ')[1]}?${new URLSearchParams(params)}`), {});

test('GET /api/video returns the exact contract', async () => {
  const { ctx, dir } = await makeCtx();
  try {
    const { routes } = create(ctx);
    assert.equal(typeof routes['GET /api/video'], 'function');
    const d = await call(routes, 'GET /api/video', { id: 'https://youtu.be/dQw4w9WgXcQ?t=5', keyword: 'budget phone', tz: '-330' });
    assert.deepEqual(Object.keys(d).sort(), ['channel', 'meta', 'outlierScore', 'seo', 'video']);
    assert.deepEqual(Object.keys(d.video).sort(), ['ageDays', 'channelId', 'channelTitle', 'comments', 'description', 'durationSec', 'engagementRate',
      'id', 'isShort', 'likes', 'publishedAt', 'tags', 'thumbnail', 'title', 'views', 'viewsPerDay'].sort());
    assert.equal(d.video.id, 'dQw4w9WgXcQ');
    assert.equal(typeof d.video.description, 'string');
    assert.ok(Array.isArray(d.video.tags));
    assert.equal(d.channel.id, d.video.channelId);
    assert.ok('medianViews' in d.channel && 'uploadsPerWeek' in d.channel && 'subscribers' in d.channel);
    assert.ok(d.outlierScore === null || d.outlierScore > 0);
    const base = d.video.isShort ? d.channel.medianViewsShorts : d.channel.medianViewsLong;
    assert.ok(Math.abs(d.outlierScore - d.video.views / base) < 1e-9);
    assert.deepEqual(Object.keys(d.seo).sort(), ['checks', 'grade', 'score']);
    assert.ok(d.seo.checks.some((c) => c.id === 'keyword-title'));
    assert.ok(d.seo.checks.some((c) => c.id === 'engagement'), 'channel context enables the engagement check');
    for (const c of d.seo.checks) {
      for (const k of ['id', 'label', 'passed', 'points', 'maxPoints', 'detail', 'kind']) assert.ok(k in c, `${c.id} lacks ${k}`);
    }
    assert.equal(d.meta.mode, 'demo');
    // Plain 11-character ID works too and returns the same video
    const again = await call(routes, 'GET /api/video', { id: 'dQw4w9WgXcQ' });
    assert.equal(again.video.title, d.video.title);
    assert.ok(!again.seo.checks.some((c) => c.id === 'keyword-title'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GET /api/video: 400 for unparseable ids, 404 for unknown videos', async () => {
  class EmptyClient extends DemoClient { async getVideos() { return []; } }
  const { ctx, dir } = await makeCtx(new EmptyClient());
  try {
    const { routes } = create(ctx);
    await assert.rejects(call(routes, 'GET /api/video', { id: 'not a video' }), { status: 400 });
    await assert.rejects(call(routes, 'GET /api/video', {}), { status: 400 });
    await assert.rejects(call(routes, 'GET /api/video', { id: 'https://example.com/watch?v=dQw4w9WgXcQ' }), { status: 400 });
    await assert.rejects(call(routes, 'GET /api/video', { id: 'dQw4w9WgXcQ' }), { status: 404 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GET /api/audit/channel returns a full audit', async () => {
  const { ctx, dir } = await makeCtx();
  try {
    const { routes } = create(ctx);
    const d = await call(routes, 'GET /api/audit/channel', { q: '@gadgetlab', max: '30' });
    assert.deepEqual(Object.keys(d).sort(), ['channel', 'grade', 'meta', 'recommendations', 'score', 'sections', 'videos']);
    assert.equal(d.channel.title, 'gadgetlab');
    assert.equal(d.videos.length, 30);
    assert.equal(d.sections.length, 5);
    assert.ok(d.score >= 0 && d.score <= 100);
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(d.grade));
    assert.ok(Array.isArray(d.recommendations));
    for (const v of d.videos) {
      assert.ok(Number.isFinite(v.seoScore));
      assert.ok(Array.isArray(v.topIssues));
    }
    // max is clamped to 10..200
    const small = await call(routes, 'GET /api/audit/channel', { q: '@gadgetlab', max: '1' });
    assert.equal(small.videos.length, 10);
    await assert.rejects(call(routes, 'GET /api/audit/channel', { q: '  ' }), { status: 400 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
