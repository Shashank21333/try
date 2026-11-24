// Video SEO score and channel audit. Pure functions only (no I/O), so all of it is unit-tested.
//
// Every check reports `kind`:
//   'rule'      = it enforces an official, documented YouTube requirement (sources below);
//   'heuristic' = a best-practice rule of thumb. Thresholds are ours, not YouTube's.
// Scores are the share of available points earned, so checks that do not apply (no keyword,
// a Short, no channel context) are left out instead of counting as failures.
import {
  normalizeVideo, scoreOutliers, channelSummary, median, mean, parseDuration, SHORT_MAX_SECONDS,
} from './analytics.js';

const DAY_MS = 86_400_000;

// ---- Official YouTube rules (verified against the linked documentation) ----
// Chapters, https://support.google.com/youtube/answer/9884579 : the first timestamp starts at 00:00,
// "at least three timestamps listed in ascending order", "minimum length for video chapters is 10 seconds".
export const CHAPTER_MIN_COUNT = 3;
export const CHAPTER_MIN_SECONDS = 10;
// Tags, https://developers.google.com/youtube/v3/docs/videos (snippet.tags): at most 500 characters;
// commas between tags count, and a tag containing a space counts as if wrapped in quotation marks.
export const TAGS_MAX_CHARS = 500;
// Hashtags, https://support.google.com/youtube/answer/6390658 : "If a video or playlist has more than
// 60 hashtags, we'll ignore each hashtag on that content." Up to three may appear by the title.
export const HASHTAGS_MAX = 60;
// Titles: 100 characters max; descriptions: 5,000 bytes max (videos resource docs, link above).
export const TITLE_MAX_CHARS = 100;
// Links in Shorts descriptions are not clickable (https://support.google.com/youtube/answer/13748639).

// ---- Heuristics (our rules of thumb, labelled as such in the UI) ----
export const TITLE_MIN_CHARS = 20;
export const TITLE_VISIBLE_CHARS = 70; // roughly what search/suggested show before truncating; varies by device
export const DESCRIPTION_PREVIEW_CHARS = 150; // roughly what shows before "...more"
export const DESCRIPTION_GOOD_CHARS = 250;
export const SHORT_DESCRIPTION_GOOD_CHARS = 100;
export const HASHTAGS_PLENTY = 15; // YouTube: "Don't add too many tags", but sets no number below 60

/** Letter grade for a 0-100 score. */
export const GRADES = [[85, 'A'], [70, 'B'], [55, 'C'], [40, 'D'], [0, 'F']];
export const gradeFor = (score) => GRADES.find(([min]) => score >= min)[1];

const len = (s) => [...String(s ?? '')].length;
const pctStr = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const fmtTime = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const quoteList = (titles, max = 2) => [...new Set(titles)].slice(0, max).map((t) => `"${t}"`).join(', ');

// ---------------------------------------------------------------- inputs

/**
 * Video ID from an 11-character ID or any common YouTube URL:
 * watch?v=, youtu.be/, /shorts/, /embed/, /live/, /v/, m./music. hosts and youtube-nocookie.com.
 */
export function parseVideoId(input) {
  const s = String(input ?? '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  if (!s || s.length > 2048) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = /^\/(?:shorts|embed|live|v|e)\/([^/]+)/.exec(u.pathname)?.[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** Trimmed target keyword (max 100 chars) or ''. */
export const cleanKeyword = (k) => String(k ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

// Lowercase, accents kept, punctuation folded to spaces: "Budget-Phone!" -> "budget phone".
const normText = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
// Scripts written without spaces between words: a word boundary cannot be found there.
const NO_SPACES_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
// Match on a word boundary at the start, so "budget phone" also matches "budget phones";
// plain substring match for Japanese, Chinese, Thai etc. ("格安スマホ" in "最強の格安スマホ").
const contains = (normalized, kw) => (NO_SPACES_RE.test(kw) ? normalized.includes(kw) : ` ${normalized} `.includes(` ${kw}`));
const hasPhrase = (text, kw) => Boolean(kw) && contains(normText(text), kw);
const hasAllWords = (text, kw) => {
  const t = normText(text);
  return Boolean(kw) && kw.split(' ').every((w) => contains(t, w));
};

// ---------------------------------------------------------------- description parsing

/** "1:02:03" / "12:05" / "0:00" -> seconds, or null. */
export function parseTimestamp(str) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(str));
  if (!m) return null;
  const h = m[1] === undefined ? 0 : Number(m[1]);
  const min = Number(m[2]), sec = Number(m[3]);
  if (sec > 59 || (m[1] !== undefined && min > 59)) return null;
  return h * 3600 + min * 60 + sec;
}

const TS = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}`;
// "0:00 Intro", "- 0:00 Intro", "[0:00] Intro", "00:00 - Intro"
const TS_START = new RegExp(String.raw`^[\s\p{P}\p{S}]*?(${TS})(?![\d:])[\s\p{P}\p{S}]*(.*)$`, 'u');
// "Intro - 0:00", "Intro (0:00)"
const TS_END = new RegExp(String.raw`^(.*?[\p{L}\p{N}].*?)[\s\p{P}\p{S}]+(${TS})[\s\p{P}]*$`, 'u');

/** One description line as { start, title, style } when it is a timestamp line, else null. */
function timestampLine(line) {
  let m = TS_START.exec(line);
  const start = m ? parseTimestamp(m[1]) : null;
  if (start !== null) return { start, title: m[2].trim(), style: 'start' };
  m = TS_END.exec(line);
  const end = m ? parseTimestamp(m[2]) : null;
  return end === null ? null : { start: end, title: m[1].trim(), style: 'end' };
}

/**
 * The chapter list in a description: YouTube asks for "a list of timestamps and titles", so a
 * stray time elsewhere (a schedule "every Friday at 18:00", a track length "Lofi beat - 2:45")
 * must not be read as a chapter. Lines are grouped into blocks of adjacent timestamp lines in the
 * same format (time first or time last). The list is the first block with a 0:00 entry or, failing
 * that, the first time-first block that has 2+ entries (a list that forgot 0:00). Later blocks in
 * the same format are added while they continue the ascending order inside the video, which covers
 * lists split by blank lines or section headings. Time-last lines without 0:00 are never treated
 * as a list: they cannot be told apart from credits and track lengths.
 */
function findChapterList(lines, durationSec) {
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const e = timestampLine(line);
    if (e && cur?.style === e.style) cur.entries.push(e);
    else if (e) blocks.push(cur = { style: e.style, entries: [e] });
    else cur = null; // a blank or text line ends the block
  }
  const extend = (i) => {
    const list = [...blocks[i].entries];
    for (const b of blocks.slice(i + 1)) {
      if (b.style !== blocks[i].style) continue;
      const first = b.entries[0].start;
      if (first <= list.at(-1).start || (durationSec > 0 && first >= durationSec)) break;
      list.push(...b.entries);
    }
    return list;
  };
  let i = blocks.findIndex((b) => b.entries.some((e) => e.start === 0));
  if (i < 0) i = blocks.findIndex((b, j) => b.style === 'start' && extend(j).length >= 2);
  const total = blocks.reduce((s, b) => s + b.entries.length, 0);
  const chapters = i < 0 ? [] : extend(i);
  return { chapters, ignored: total - chapters.length };
}

/**
 * Chapter timestamps in a description, validated against YouTube's documented rules
 * (first at 0:00, at least 3, ascending, each chapter >= 10 s; the last chapter is
 * checked against the video length when known). Only the chapter list itself is checked
 * (see findChapterList); `ignored` counts other timestamp lines that were left out.
 * Returns { found, valid, count, chapters: [{ start, title }], problems: [string], ignored }.
 */
export function parseChapters(description, durationSec = 0) {
  const { chapters, ignored } = findChapterList(String(description ?? '').split(/\r?\n/), durationSec);
  const problems = [];
  if (chapters.length) {
    if (chapters.length < CHAPTER_MIN_COUNT) {
      problems.push(`Only ${chapters.length} timestamp${chapters.length === 1 ? '' : 's'}: YouTube needs at least ${CHAPTER_MIN_COUNT}.`);
    }
    if (chapters[0].start !== 0) problems.push(`The first timestamp is ${fmtTime(chapters[0].start)}; it must be 0:00.`);
    for (let i = 1; i < chapters.length; i++) {
      const prev = chapters[i - 1].start, cur = chapters[i].start;
      if (cur <= prev) {
        problems.push(`Timestamps must be in ascending order (${fmtTime(cur)} comes after ${fmtTime(prev)}).`);
      } else if (cur - prev < CHAPTER_MIN_SECONDS) {
        problems.push(`The chapter at ${fmtTime(prev)} is only ${cur - prev} s long; chapters must be at least ${CHAPTER_MIN_SECONDS} seconds.`);
      }
    }
    const last = chapters.at(-1).start;
    if (durationSec > 0) {
      if (last >= durationSec) problems.push(`Timestamp ${fmtTime(last)} is past the end of the video (${fmtTime(durationSec)}).`);
      else if (durationSec - last < CHAPTER_MIN_SECONDS) {
        problems.push(`The last chapter (${fmtTime(last)}) is only ${durationSec - last} s long; chapters must be at least ${CHAPTER_MIN_SECONDS} seconds.`);
      }
    }
  }
  const chapterList = chapters.map(({ start, title }) => ({ start, title }));
  return { found: chapters.length > 0, valid: chapters.length > 0 && !problems.length, count: chapters.length, chapters: chapterList, problems, ignored };
}

/** Distinct hashtags (lowercased) in a text. Must contain a letter; "C#" and URL #fragments are not hashtags. */
export function extractHashtags(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/(?:^|[^\p{L}\p{M}\p{N}_&/#])#([\p{L}\p{M}\p{N}_]+)/gu)) {
    if (/\p{L}/u.test(m[1])) out.add(m[1].toLowerCase());
  }
  return [...out];
}

/** Tag characters as the YouTube API counts them: commas between tags, +2 quotes for tags with spaces. */
export function tagCharCount(tags) {
  const list = (tags || []).map(String);
  if (!list.length) return 0;
  return list.reduce((s, t) => s + len(t) + (/\s/.test(t) ? 2 : 0), 0) + (list.length - 1);
}

const LINK_RE = /\bhttps?:\/\/\S+|\bwww\.[a-z\d-]+\.[a-z]/i;
// English call-to-action phrases only (heuristic).
const CTA_RE = /\b(subscribe|comment|let me know|check out|watch (?:next|this|the full|more)|click|join|follow|sign up|download|learn more|visit|link(?:s)? (?:in|below)|shop|support (?:the|this|me|us)|patreon)\b/i;

// An ALL-CAPS word long enough not to be a typical acronym (GPU, NASA, FAA are 3-4 letters).
export const SHOUT_WORD_MIN = 5;
const SHOUT_WORD_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])\p{Lu}{${SHOUT_WORD_MIN},}(?![\p{L}\p{N}])`, 'gu');

/**
 * True when a title "shouts": mostly upper-case letters, or 2+ different ALL-CAPS words of
 * SHOUT_WORD_MIN+ letters. Shorter capitalised words are ignored because they are usually
 * acronyms ("AMD vs NVIDIA: Best GPU" is not shouting).
 */
export function isShouty(title) {
  const t = String(title ?? '');
  const letters = [...t].filter((c) => /\p{L}/u.test(c) && c.toLowerCase() !== c.toUpperCase());
  const upper = letters.filter((c) => c === c.toUpperCase()).length;
  if (letters.length >= 8 && upper / letters.length >= 0.6) return true;
  return new Set(t.match(SHOUT_WORD_RE) || []).size >= 2;
}

// ---------------------------------------------------------------- video score

function makeCheck({ id, label, kind, maxPoints, points, detail, fix, info = false }) {
  const pts = Math.max(0, Math.min(maxPoints, Math.round(points)));
  const passed = info || pts >= maxPoints;
  const c = { id, label, kind, passed, points: pts, maxPoints, detail };
  if (!passed && fix) c.fix = fix;
  if (info) c.info = true;
  return c;
}

/** score = share of available points; grade from GRADES. */
export function summarize(checks) {
  const max = checks.reduce((s, c) => s + c.maxPoints, 0);
  const got = checks.reduce((s, c) => s + c.points, 0);
  const score = max > 0 ? Math.round((got / max) * 100) : 0;
  return { score, grade: gradeFor(score) };
}

/**
 * Score one raw videos.list item.
 * opts.keyword: target keyword (enables the keyword checks).
 * opts.context: { medianEngagement, format } of the channel's recent uploads in the same format
 *   (enables the engagement check).
 * Weights (max points): title 10, keyword in title 10, keyword early in description 8, keyword in
 * tags 3, description 10 (Shorts 6), chapters 10 (long-form only), tags 3, tag limit 3, hashtags 3,
 * hashtag limit 3 (only with hashtags),
 * links + call to action 4 (Shorts: call to action 2), HD thumbnail 8 (long-form only),
 * captions 8 (Shorts 4), HD video 4, engagement 8.
 */
export function scoreVideo(item, { keyword = '', context = null } = {}) {
  const sn = item?.snippet || {};
  const cd = item?.contentDetails || {};
  const st = item?.statistics || {};
  const title = String(sn.title || '');
  const description = String(sn.description || '');
  const tags = Array.isArray(sn.tags) ? sn.tags : [];
  const durationSec = parseDuration(cd.duration);
  const isShort = durationSec > 0 && durationSec <= SHORT_MAX_SECONDS;
  const kw = normText(cleanKeyword(keyword));
  const checks = [];
  const add = (c) => checks.push(makeCheck(c));

  // Title length (heuristic; the hard limit is 100 characters)
  const tLen = len(title.trim());
  add({
    id: 'title-length', label: 'Title length', kind: 'heuristic', maxPoints: 10,
    points: tLen >= TITLE_MIN_CHARS && tLen <= TITLE_VISIBLE_CHARS ? 10 : tLen ? 5 : 0,
    detail: !tLen ? 'The video has no title.'
      : tLen < TITLE_MIN_CHARS ? `${tLen} characters. Very short titles give viewers and search little context.`
        : tLen <= TITLE_VISIBLE_CHARS ? `${tLen} characters: likely shown in full in search and suggested videos.`
          : `${tLen} characters: the end may be cut off in search and suggested videos (truncation varies by device; the hard limit is ${TITLE_MAX_CHARS}).`,
    fix: tLen < TITLE_MIN_CHARS
      ? `Describe the topic or payoff in ${TITLE_MIN_CHARS}–${TITLE_VISIBLE_CHARS} characters.`
      : `Put the words that matter most in the first ~${TITLE_VISIBLE_CHARS} characters.`,
  });

  // Keyword placement (heuristics, only with a target keyword)
  if (kw) {
    const label = `"${cleanKeyword(keyword)}"`;
    const inTitle = hasPhrase(title, kw);
    const wordsInTitle = !inTitle && hasAllWords(title, kw);
    add({
      id: 'keyword-title', label: 'Keyword in title', kind: 'heuristic', maxPoints: 10,
      points: inTitle ? 10 : wordsInTitle ? 6 : 0,
      detail: inTitle ? `The title contains ${label}.`
        : wordsInTitle ? `The title has every word of ${label}, but not as one phrase.`
          : `The title does not contain ${label}.`,
      fix: `Use the exact phrase ${label} in the title, ideally near the start.`,
    });
    const preview = [...description].slice(0, DESCRIPTION_PREVIEW_CHARS).join('');
    const early = hasPhrase(preview, kw);
    const anywhere = early || hasPhrase(description, kw);
    add({
      id: 'keyword-description', label: 'Keyword early in description', kind: 'heuristic', maxPoints: 8,
      points: early ? 8 : anywhere ? 4 : 0,
      detail: early ? `${label} appears in the first ${DESCRIPTION_PREVIEW_CHARS} characters, the part people see before "...more".`
        : anywhere ? `${label} is in the description, but not in the first ${DESCRIPTION_PREVIEW_CHARS} characters.`
          : `The description does not mention ${label}.`,
      fix: `Mention ${label} naturally in the first sentence or two of the description.`,
    });
    const inTags = tags.some((t) => hasPhrase(t, kw));
    add({
      id: 'keyword-tags', label: 'Keyword in tags', kind: 'heuristic', maxPoints: 3,
      points: inTags ? 3 : 0,
      detail: inTags ? `A tag contains ${label}. YouTube says tags play a minimal role in discovery.`
        : `No tag contains ${label}. YouTube says tags play a minimal role in discovery, so this is worth little.`,
      fix: `Add ${label} (and common misspellings of it) as a tag.`,
    });
  }

  // Description length (heuristic)
  const dLen = len(description.trim());
  const dGood = isShort ? SHORT_DESCRIPTION_GOOD_CHARS : DESCRIPTION_GOOD_CHARS;
  const dMin = isShort ? 20 : 100;
  const dMax = isShort ? 6 : 10;
  add({
    id: 'description-length', label: 'Description length', kind: 'heuristic', maxPoints: dMax,
    points: dLen >= dGood ? dMax : dLen >= dMin ? dMax / 2 : 0,
    detail: dLen ? `${dLen} characters (aim for ${dGood}+${isShort ? ' on a Short' : ''}; the hard limit is 5,000 bytes).` : 'The description is empty.',
    fix: isShort
      ? 'Add a sentence or two that names the topic in words people search for.'
      : `Write at least ${DESCRIPTION_GOOD_CHARS} characters: what the video covers, key terms, and links to related videos.`,
  });

  // Chapters (long-form only). Validity is an official rule; having chapters at all is a heuristic.
  if (!isShort) {
    const ch = parseChapters(description, durationSec);
    if (!ch.found) {
      add({
        id: 'chapters', label: 'Chapters', kind: 'heuristic', maxPoints: 10, points: 0,
        detail: `No list of chapter timestamps in the description.${ch.ignored ? ' (Lone times elsewhere in it, such as a schedule or a track length, are not counted as chapters.)' : ''} Chapters split a long video into labelled sections viewers can jump to. (Automatic chapters, if YouTube added any, are not visible through the API.)`,
        fix: `Add a list of timestamps to the description: start with 0:00, use at least ${CHAPTER_MIN_COUNT} in ascending order, and make each chapter at least ${CHAPTER_MIN_SECONDS} seconds long.`,
      });
    } else {
      add({
        id: 'chapters', label: 'Chapters', kind: 'rule', maxPoints: 10, points: ch.valid ? 10 : 0,
        detail: ch.valid
          ? `${ch.count} chapters that meet YouTube's requirements (start at 0:00, at least ${CHAPTER_MIN_COUNT} in ascending order, each at least ${CHAPTER_MIN_SECONDS} s).`
          : `Timestamps found, but YouTube will not turn them into chapters: ${ch.problems.join(' ')}`,
        fix: 'Fix the timestamps so they meet YouTube\'s chapter rules.',
      });
    }
  }

  // Tags (heuristic) and the 500-character limit (rule)
  const tagChars = tagCharCount(tags);
  add({
    id: 'tags', label: 'Tags', kind: 'heuristic', maxPoints: 3, points: tags.length ? 3 : 0,
    detail: tags.length
      ? `${tags.length} tag${tags.length === 1 ? '' : 's'} (${tagChars} of ${TAGS_MAX_CHARS} characters). YouTube says tags play a minimal role in discovery and mainly help with commonly misspelled topics.`
      : 'No tags. YouTube says tags play a minimal role in discovery and mainly help with commonly misspelled topics.',
    fix: 'Add a few tags for misspellings and alternative names of your topic.',
  });
  if (tags.length) {
    add({
      id: 'tags-limit', label: 'Tags within the 500-character limit', kind: 'rule', maxPoints: 3,
      points: tagChars <= TAGS_MAX_CHARS ? 3 : 0,
      detail: `Tags use ${tagChars} of ${TAGS_MAX_CHARS} characters, counted the way YouTube counts them (commas count, and a tag with a space counts 2 extra for quotes).`,
      fix: `Remove or shorten tags to get under ${TAGS_MAX_CHARS} characters.`,
    });
  }

  // Hashtags: using a few is a heuristic; more than 60 is an official rule (YouTube then ignores all
  // of them). YouTube does not say whether title hashtags count toward 60; we count title + description.
  const hashtags = extractHashtags(`${title}\n${description}`);
  const hn = hashtags.length;
  add({
    id: 'hashtags', label: 'Hashtags', kind: 'heuristic', maxPoints: 3,
    points: hn >= 1 && hn <= HASHTAGS_PLENTY ? 3 : hn <= HASHTAGS_MAX ? 1 : 0,
    detail: hn === 0 ? 'No hashtags. Up to three can appear by the title and link to a page of related videos.'
      : hn <= HASHTAGS_PLENTY ? `${hn} hashtag${hn === 1 ? '' : 's'} (${hashtags.slice(0, 3).map((h) => `#${h}`).join(' ')}${hn > 3 ? ' …' : ''}). Up to three can appear by the title.`
        : `${hn} hashtags. YouTube advises against adding too many and says over-tagging can get a video removed from search (rule of thumb: ${HASHTAGS_PLENTY} or fewer).`,
    fix: hn === 0 ? 'Add 1–3 relevant hashtags to the description.' : 'Keep only the few most relevant hashtags.',
  });
  if (hn) {
    add({
      id: 'hashtags-limit', label: `No more than ${HASHTAGS_MAX} hashtags`, kind: 'rule', maxPoints: 3,
      points: hn <= HASHTAGS_MAX ? 3 : 0,
      detail: hn <= HASHTAGS_MAX
        ? `${hn} hashtag${hn === 1 ? '' : 's'} in the title and description; YouTube ignores every hashtag on a video with more than ${HASHTAGS_MAX}.`
        : `${hn} hashtags in the title and description. YouTube ignores every hashtag on a video with more than ${HASHTAGS_MAX}.`,
      fix: `Cut the hashtags to a handful of relevant ones: above ${HASHTAGS_MAX}, YouTube ignores all of them.`,
    });
  }

  // Links and call to action (heuristic). Links in Shorts descriptions are not clickable.
  const hasLink = LINK_RE.test(description);
  const hasCta = CTA_RE.test(description);
  if (isShort) {
    add({
      id: 'links-cta', label: 'Call to action', kind: 'heuristic', maxPoints: 2, points: hasCta ? 2 : 0,
      detail: `${hasCta ? 'The description asks viewers to act.' : 'No call to action found (English phrases like "subscribe" or "check out" are detected).'}${hasLink ? ' This video is treated as a Short because it is 3 minutes or less (the API has no Shorts flag). If it is a Short, links in its description are not clickable.' : ''}`,
      fix: 'Ask viewers to do one thing, such as watch the related long-form video or subscribe.',
    });
  } else {
    add({
      id: 'links-cta', label: 'Links and call to action', kind: 'heuristic', maxPoints: 4,
      points: (hasLink ? 2 : 0) + (hasCta ? 2 : 0),
      detail: [hasLink ? 'Has a link.' : 'No links.', hasCta ? 'Has a call to action.' : 'No call to action found (English phrases like "subscribe" or "check out" are detected).'].join(' '),
      fix: !hasLink ? 'Link to a related video, playlist or your site in the description.' : 'Tell viewers what to do next, such as watch a related video or subscribe.',
    });
  }

  // HD thumbnail (heuristic proxy, long-form only)
  if (!isShort) {
    const maxres = Boolean(sn.thumbnails?.maxres?.url);
    add({
      id: 'thumbnail-hd', label: 'HD thumbnail available', kind: 'heuristic', maxPoints: 8, points: maxres ? 8 : 0,
      detail: maxres
        ? 'A 1280×720 ("maxres") thumbnail exists. This is only a proxy: it does not prove a custom thumbnail, because only the video\'s owner can see that through the API.'
        : 'No 1280×720 ("maxres") thumbnail, so the thumbnail may look soft on large screens. This is a proxy, not proof that no custom thumbnail was set.',
      fix: 'Upload a custom 16:9 thumbnail (needs a verified account). YouTube recommends 3840×2160, at least 640 px wide.',
    });
  }

  // Captions (heuristic; the API flag is documented only as "whether captions are available")
  if (cd.caption === 'true' || cd.caption === 'false' || typeof cd.caption === 'boolean') {
    const has = String(cd.caption) === 'true';
    const cMax = isShort ? 4 : 8;
    add({
      id: 'captions', label: 'Captions available', kind: 'heuristic', maxPoints: cMax, points: has ? cMax : 0,
      detail: has
        ? 'The YouTube API reports captions as available for this video.'
        : 'The YouTube API reports no captions for this video. YouTube does not document whether automatic captions count toward this flag.',
      fix: 'Upload captions, or review the automatic ones, in YouTube Studio → Subtitles.',
    });
  }

  // Definition (heuristic)
  if (cd.definition === 'hd' || cd.definition === 'sd') {
    add({
      id: 'definition-hd', label: 'HD video', kind: 'heuristic', maxPoints: 4, points: cd.definition === 'hd' ? 4 : 0,
      detail: cd.definition === 'hd' ? 'Available in HD.' : 'Only available in standard definition.',
      fix: 'Upload in at least 720p.',
    });
  }

  // Engagement vs the channel's typical upload of the same format (heuristic). The baseline is
  // (likes + comments) / views, so a video whose like count is hidden cannot be compared with it.
  // Disabled comments count as 0: the video really gets none.
  const views = Number(st.viewCount);
  const likes = st.likeCount === undefined ? null : Number(st.likeCount);
  const comments = st.commentCount === undefined ? 0 : Number(st.commentCount);
  const er = views > 0 && likes !== null ? (likes + comments) / views : null;
  const base = context?.medianEngagement;
  if (views > 0 && likes === null && Number.isFinite(base) && base > 0) {
    add({
      id: 'engagement', label: 'Engagement vs channel', kind: 'heuristic', maxPoints: 0, points: 0, info: true,
      detail: 'The like count is hidden, so engagement cannot be compared with the channel\'s other uploads.',
    });
  } else if (er !== null && Number.isFinite(base) && base > 0) {
    const ratio = er / base;
    add({
      id: 'engagement', label: 'Engagement vs channel', kind: 'heuristic', maxPoints: 8,
      points: ratio >= 0.8 ? 8 : ratio >= 0.5 ? 4 : 0,
      detail: `(Likes + comments) ÷ views is ${pctStr(er, 2)} vs ${pctStr(base, 2)} typical for this channel's ${isShort ? 'Shorts' : 'long-form uploads'} (${ratio.toFixed(2)}×).`,
      fix: 'Ask a specific question to invite comments, and pin a comment that starts the conversation.',
    });
  }

  return { ...summarize(checks), checks };
}

/** Failed checks ordered by points lost (most first). */
export const failedChecks = (checks) => checks.filter((c) => !c.passed)
  .sort((a, b) => (b.maxPoints - b.points) - (a.maxPoints - a.points));

/** (likes + comments) / views of normalized videos whose like count is public. */
const engagementRates = (videos) => videos
  .filter((v) => v.likes !== null && Number.isFinite(v.engagementRate)).map((v) => v.engagementRate);

/**
 * Median views and engagement per format, used as the "typical upload" baseline.
 * Videos with a hidden like count are left out of the engagement median (their rate would be
 * comments only and pull the baseline down).
 */
export function formatBaselines(videos) {
  const out = {};
  for (const [key, isShort] of [['short', true], ['long', false]]) {
    const list = videos.filter((v) => v.isShort === isShort);
    out[key] = {
      count: list.length,
      medianViews: median(list.map((v) => v.views)),
      medianEngagement: median(engagementRates(list)),
    };
  }
  return out;
}

// ---------------------------------------------------------------- channel audit

// Section weights in the overall channel score.
export const SECTION_WEIGHTS = { Consistency: 20, Optimization: 30, Packaging: 20, Performance: 20, 'Channel setup': 10 };

/** Override pass/fail for checks judged by a threshold rather than by full points. */
function withPass(check, passed, fix) {
  const c = { ...check, passed };
  delete c.fix;
  if (!passed && fix) c.fix = fix;
  return c;
}

/** Heuristic check whose points scale with a share (0-1) and which passes at `pass` or above. */
const shareCheck = ({ share, pass, fix, ...rest }) =>
  withPass(makeCheck({ ...rest, kind: 'heuristic', points: share * rest.maxPoints }), share >= pass, fix);

/** Longest stretch without an upload in the last 90 days (counting the time since the last upload). */
export function longestGapDays(publishTimes, { now = Date.now(), coversWindow = true } = {}) {
  const since = now - 90 * DAY_MS;
  const recent = publishTimes.filter((t) => Number.isFinite(t) && t >= since && t <= now).sort((a, b) => a - b);
  const all = publishTimes.filter(Number.isFinite);
  if (!recent.length) return all.length ? Math.min(90, (now - Math.max(...all)) / DAY_MS) : 90;
  const points = [...(coversWindow ? [since] : []), ...recent, now];
  let gap = 0;
  for (let i = 1; i < points.length; i++) gap = Math.max(gap, points[i] - points[i - 1]);
  return gap / DAY_MS;
}

const topTitles = (list) => quoteList([...list].sort((a, b) => b.v.views - a.v.views).map((x) => x.v.title));

/**
 * Full channel audit from a raw channels.list item and raw videos.list items (newest first).
 * Returns { channel, score, grade, sections, videos, recommendations }.
 */
export function auditChannel(rawChannel, rawVideos, { now = Date.now(), complete = false } = {}) {
  const items = (rawVideos || []).filter(Boolean).map((raw) => ({ raw, v: normalizeVideo(raw, now) })).filter((x) => !x.v.isLive);
  const scored = scoreOutliers(items.map((x) => x.v));
  items.forEach((x, i) => { x.v = scored[i]; });
  const channel = channelSummary(rawChannel, scored, { now, complete });
  const base = formatBaselines(scored);
  for (const x of items) x.seo = scoreVideo(x.raw, { context: base[x.v.isShort ? 'short' : 'long'] });

  const total = items.length;
  const long = items.filter((x) => !x.v.isShort);
  const shorts = items.filter((x) => x.v.isShort);
  const sections = [];
  const sample = complete ? `all ${total} uploads` : `the ${total} most recent uploads`;

  // ---- Consistency
  const consistency = [];
  if (total) {
    const upw = channel.uploadsPerWeek;
    consistency.push(makeCheck({
      id: 'uploads-per-week', label: 'Upload frequency', kind: 'heuristic', maxPoints: 10,
      points: upw >= 1 ? 10 : upw >= 0.5 ? 6 : upw >= 0.25 ? 3 : 0,
      detail: `${upw.toFixed(1)} uploads per week over the last ${channel.uploadsWindowDays} days (rule of thumb: at least 1 a week).`,
      fix: `Upload more regularly: ${upw.toFixed(1)} uploads a week is below the 1-a-week rule of thumb. A schedule you can keep beats bursts.`,
    }));
    const times = scored.map((v) => Date.parse(v.publishedAt));
    const oldest = Math.min(...times.filter(Number.isFinite));
    // Count the stretch from the window start only when we saw uploads from before it: otherwise the
    // channel is newer than 90 days (complete history) or our sample does not reach back that far.
    const coversWindow = oldest <= now - 90 * DAY_MS;
    const gap = longestGapDays(times, { now, coversWindow });
    consistency.push(makeCheck({
      id: 'longest-gap', label: 'Longest gap (last 90 days)', kind: 'heuristic', maxPoints: 10,
      points: gap <= 14 ? 10 : gap <= 30 ? 5 : 0,
      detail: `Longest stretch without an upload in the last 90 days: ${Math.round(gap)} days${coversWindow || complete ? '' : ` (only ${sample} were checked)`}. Rule of thumb: 14 days or less.`,
      fix: `Avoid long breaks: the longest recent gap was ${Math.round(gap)} days. Batch-record videos ahead of time to cover busy weeks.`,
    }));
    const since = channel.daysSinceLastUpload;
    consistency.push(makeCheck({
      id: 'last-upload', label: 'Days since last upload', kind: 'heuristic', maxPoints: 10,
      points: since <= 14 ? 10 : since <= 30 ? 5 : 0,
      detail: `The latest upload is ${Math.round(since)} days old (rule of thumb: 14 days or less).`,
      fix: `Publish something new: the last upload was ${Math.round(since)} days ago.`,
    }));
  } else {
    consistency.push(makeCheck({
      id: 'uploads-per-week', label: 'Upload frequency', kind: 'heuristic', maxPoints: 10, points: 0,
      detail: 'No public uploads found.', fix: 'Publish your first video.',
    }));
  }
  sections.push({ title: 'Consistency', checks: consistency });

  // ---- Optimization
  const optimization = [];
  if (total) {
    const avg = mean(items.map((x) => x.seo.score));
    optimization.push(withPass(makeCheck({
      id: 'avg-seo', label: 'Average video SEO score', kind: 'heuristic', maxPoints: 10, points: avg / 10,
      detail: `Average SEO score across ${sample}: ${Math.round(avg)}/100 (grade ${gradeFor(Math.round(avg))}).`,
    }), avg >= 70, `Raise the average video SEO score (${Math.round(avg)}/100): open the lowest-scoring videos below and work through their failed checks.`));
    if (long.length) {
      const missing = long.filter((x) => !x.seo.checks.find((c) => c.id === 'chapters')?.passed);
      const share = 1 - missing.length / long.length;
      optimization.push(shareCheck({
        id: 'chapters-share', label: 'Long-form videos with chapters', share, maxPoints: 8, pass: 0.5,
        detail: `${pctStr(share)} of long-form videos (${long.length - missing.length} of ${long.length}) have valid chapters.`,
        fix: `Add chapters to ${missing.length} long-form video${missing.length === 1 ? '' : 's'}, starting with the most viewed: ${topTitles(missing)}. Start at 0:00, use at least ${CHAPTER_MIN_COUNT} timestamps, each chapter at least ${CHAPTER_MIN_SECONDS} s.`,
      }));
    }
    const untagged = items.filter((x) => !(x.raw.snippet?.tags || []).length);
    const tagShare = 1 - untagged.length / total;
    optimization.push(shareCheck({
      id: 'tags-share', label: 'Videos with tags', share: tagShare, maxPoints: 3, pass: 0.8,
      detail: `${pctStr(tagShare)} of videos have tags. YouTube says tags play a minimal role in discovery.`,
      fix: `Add a few tags (misspellings, alternative names) to ${untagged.length} untagged video${untagged.length === 1 ? '' : 's'}; low priority, as YouTube says tags play a minimal role.`,
    }));
    const withCapFlag = items.filter((x) => x.seo.checks.some((c) => c.id === 'captions'));
    if (withCapFlag.length) {
      const noCaps = withCapFlag.filter((x) => !x.seo.checks.find((c) => c.id === 'captions').passed);
      const share = 1 - noCaps.length / withCapFlag.length;
      optimization.push(shareCheck({
        id: 'captions-share', label: 'Videos with captions', share, maxPoints: 6, pass: 0.5,
        detail: `${pctStr(share)} of videos have captions according to the YouTube API (it is not documented whether automatic captions count).`,
        fix: `Upload or review captions for ${noCaps.length} video${noCaps.length === 1 ? '' : 's'}, starting with ${topTitles(noCaps)}.`,
      }));
    }
    // Description quality = share of points earned on the description checks.
    const descIds = ['description-length', 'links-cta', 'hashtags', 'hashtags-limit'];
    const descChecks = items.flatMap((x) => x.seo.checks.filter((c) => descIds.includes(c.id)));
    const descShare = descChecks.reduce((s, c) => s + c.points, 0) / Math.max(1, descChecks.reduce((s, c) => s + c.maxPoints, 0));
    const passShare = (id) => pctStr(items.filter((x) => x.seo.checks.find((c) => c.id === id)?.passed).length / total);
    const shortDesc = items.filter((x) => !x.seo.checks.find((c) => c.id === 'description-length').passed);
    optimization.push(shareCheck({
      id: 'description-quality', label: 'Description quality', share: descShare, maxPoints: 8, pass: 0.75,
      detail: `${passShare('description-length')} have a full-length description, ${passShare('links-cta')} include links and a call to action (Shorts: a call to action), ${passShare('hashtags')} use 1–${HASHTAGS_PLENTY} hashtags.`,
      fix: shortDesc.length
        ? `Expand ${shortDesc.length} thin description${shortDesc.length === 1 ? '' : 's'} (under ${DESCRIPTION_GOOD_CHARS} characters for long-form, ${SHORT_DESCRIPTION_GOOD_CHARS} for Shorts), starting with ${topTitles(shortDesc)}, and add a link plus a call to action.`
        : 'Add a link, a call to action and 1–3 relevant hashtags to each description.',
    }));
  }
  sections.push({ title: 'Optimization', checks: optimization });

  // ---- Packaging
  const packaging = [];
  if (total) {
    const lens = items.map((x) => len(x.v.title.trim()));
    const short = lens.filter((l) => l < TITLE_MIN_CHARS).length;
    const longT = lens.filter((l) => l > TITLE_VISIBLE_CHARS).length;
    const ok = total - short - longT;
    const share = ok / total;
    packaging.push(shareCheck({
      id: 'title-length-dist', label: 'Title length', share, maxPoints: 8, pass: 0.8,
      detail: `${pctStr(ok / total)} of titles are ${TITLE_MIN_CHARS}–${TITLE_VISIBLE_CHARS} characters, ${pctStr(short / total)} shorter, ${pctStr(longT / total)} longer (may be cut off). Median: ${Math.round(median(lens))} characters.`,
      fix: longT >= short
        ? `Shorten ${longT} title${longT === 1 ? '' : 's'} over ${TITLE_VISIBLE_CHARS} characters, or move the key words to the front.`
        : `Make ${short} very short title${short === 1 ? '' : 's'} (under ${TITLE_MIN_CHARS} characters) more descriptive.`,
    }));
    const shouty = items.filter((x) => isShouty(x.v.title));
    const sShare = shouty.length / total;
    packaging.push(makeCheck({
      id: 'all-caps', label: 'ALL-CAPS overuse', kind: 'heuristic', maxPoints: 6,
      points: sShare <= 0.2 ? 6 : sShare <= 0.4 ? 3 : 0,
      detail: `${pctStr(sShare)} of titles are mostly capitals or have 2+ ALL-CAPS words of ${SHOUT_WORD_MIN}+ letters (rule of thumb: 20% or less; one emphasized word is fine, and shorter words are skipped as likely acronyms such as GPU or NASA).`,
      fix: `Tone down capitals in ${shouty.length} title${shouty.length === 1 ? '' : 's'}, such as ${topTitles(shouty)}. Emphasize one word at most.`,
    }));
    if (long.length) {
      const noMax = long.filter((x) => !x.raw.snippet?.thumbnails?.maxres?.url);
      const share = 1 - noMax.length / long.length;
      packaging.push(shareCheck({
        id: 'thumbnail-hd-share', label: 'HD thumbnails (long-form)', share, maxPoints: 4, pass: 0.8,
        detail: `${pctStr(share)} of long-form videos have a 1280×720 thumbnail. This is a proxy: it does not prove a custom thumbnail.`,
        fix: `Check the thumbnails of ${noMax.length} long-form video${noMax.length === 1 ? '' : 's'} without an HD version, such as ${topTitles(noMax)}. YouTube recommends uploading 3840×2160.`,
      }));
    }
  }
  sections.push({ title: 'Packaging', checks: packaging });

  // ---- Performance
  const performance = [];
  if (total) {
    if (Number.isFinite(channel.viewsPerSubscriber)) {
      const vps = channel.viewsPerSubscriber;
      performance.push(makeCheck({
        id: 'views-per-sub', label: 'Median views per subscriber', kind: 'heuristic', maxPoints: 8,
        points: vps >= 0.1 ? 8 : vps >= 0.03 ? 4 : 0,
        detail: `A typical recent upload gets views equal to ${pctStr(vps, 1)} of the subscriber count (rule of thumb: 10%+ suggests an active audience).`,
        fix: `Recent uploads reach only ${pctStr(vps, 1)} of your subscriber count. Study your outlier videos below and make more on those topics.`,
      }));
    }
    // Not channel.avgEngagement: that also averages comments-only rates of videos with hidden likes.
    const rates = engagementRates(scored);
    const eng = mean(rates);
    if (rates.length && eng > 0) {
      performance.push(makeCheck({
        id: 'engagement', label: 'Engagement rate', kind: 'heuristic', maxPoints: 6,
        points: eng >= 0.04 ? 6 : eng >= 0.02 ? 3 : 0,
        detail: `Average (likes + comments) ÷ views: ${pctStr(eng, 2)} (rule of thumb: 4%+ is strong, under 2% is weak).`,
        fix: `Engagement is ${pctStr(eng, 2)}. End videos with a specific question and reply to early comments.`,
      }));
    }
    const mature = items.filter((x) => x.v.ageDays >= 2 && x.v.outlierScore !== null);
    if (mature.length >= 5) {
      const hits = mature.filter((x) => x.v.outlierScore >= 2);
      const rate = hits.length / mature.length;
      performance.push(makeCheck({
        id: 'outlier-rate', label: 'Outlier hit rate', kind: 'heuristic', maxPoints: 6,
        points: rate >= 0.1 ? 6 : rate >= 0.05 ? 3 : 0,
        detail: `${hits.length} of ${mature.length} videos (${pctStr(rate)}) got at least 2× the channel's typical views for their format (rule of thumb: 10%+).`,
        fix: 'Few videos break out. Test bolder topics, titles and thumbnails, and repeat what your best outliers did.',
      }));
    }
    const mix = shorts.length && long.length
      ? `Long-form: ${long.length} uploads, median ${Math.round(base.long.medianViews).toLocaleString('en')} views, ${pctStr(base.long.medianEngagement, 2)} engagement. Shorts: ${shorts.length} uploads, median ${Math.round(base.short.medianViews).toLocaleString('en')} views, ${pctStr(base.short.medianEngagement, 2)} engagement. Shorts views are counted differently, so compare each format with itself.`
      : `Only ${shorts.length ? 'Shorts' : 'long-form videos'} in ${sample}.`;
    performance.push(makeCheck({
      id: 'format-mix', label: 'Shorts vs long-form', kind: 'heuristic', maxPoints: 0, points: 0, info: true, detail: mix,
    }));
  }
  sections.push({ title: 'Performance', checks: performance });

  // ---- Channel setup (profile completeness; YouTube does not document these as ranking factors)
  const setup = [];
  setup.push(makeCheck({
    id: 'channel-keywords', label: 'Channel keywords set', kind: 'heuristic', maxPoints: 3,
    points: channel.keywords.length ? 3 : 0,
    detail: channel.keywords.length ? `${channel.keywords.length} channel keywords set.` : 'No channel keywords set.',
    fix: 'Add channel keywords that describe your niche in YouTube Studio → Settings → Channel.',
  }));
  const cdLen = len(channel.description.trim());
  setup.push(makeCheck({
    id: 'channel-description', label: 'Channel description', kind: 'heuristic', maxPoints: 4,
    points: cdLen >= 300 ? 4 : cdLen >= 100 ? 2 : 0,
    detail: cdLen ? `${cdLen} characters (rule of thumb: 300+ that say who the channel is for and what to expect).` : 'The channel has no description.',
    fix: 'Write a channel description of 300+ characters: who it is for, what you post, and how often.',
  }));
  setup.push(makeCheck({
    id: 'country', label: 'Country set', kind: 'heuristic', maxPoints: 2,
    points: channel.country ? 2 : 0,
    detail: channel.country ? `Country: ${channel.country}.` : 'No country set on the channel.',
    fix: 'Set your channel country in YouTube Studio → Settings → Channel.',
  }));
  sections.push({ title: 'Channel setup', checks: setup });

  // ---- Totals
  for (const s of sections) {
    const max = s.checks.reduce((a, c) => a + c.maxPoints, 0);
    s.score = max > 0 ? Math.round((s.checks.reduce((a, c) => a + c.points, 0) / max) * 100) : null;
    s.weight = SECTION_WEIGHTS[s.title];
  }
  const scoredSections = sections.filter((s) => s.score !== null);
  const wsum = scoredSections.reduce((a, s) => a + s.weight, 0);
  const score = wsum ? Math.round(scoredSections.reduce((a, s) => a + s.score * s.weight, 0) / wsum) : 0;

  // Recommendations: failed checks, ordered by how many overall points fixing them would add.
  const recommendations = sections.flatMap((s) => {
    const max = s.checks.reduce((a, c) => a + c.maxPoints, 0);
    return s.checks.filter((c) => !c.passed && c.fix && max > 0)
      .map((c) => ({ text: c.fix, impact: ((c.maxPoints - c.points) / max) * s.weight }));
  }).sort((a, b) => b.impact - a.impact).map((r) => r.text);

  const videos = items.map((x) => ({
    id: x.v.id,
    title: x.v.title,
    publishedAt: x.v.publishedAt,
    isShort: x.v.isShort,
    views: x.v.views,
    outlierScore: x.v.outlierScore,
    seoScore: x.seo.score,
    grade: x.seo.grade,
    topIssues: failedChecks(x.seo.checks).slice(0, 3).map((c) => c.label),
  }));

  return { channel, score, grade: gradeFor(score), sections, videos, recommendations };
}
