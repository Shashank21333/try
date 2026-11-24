// Demo client: returns SYNTHETIC data in the exact shape of the YouTube Data API,
// so the whole app can be tried without an API key. Nothing here is real.
import { parseChannelInput } from './youtube.js';

function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const makeId = (seed, len) => { const r = rng(seed); return Array.from({ length: len }, () => ID_CHARS[Math.floor(r() * 64)]).join(''); };
const sig3 = (n) => { if (n < 1000) return n; const p = 10 ** (Math.floor(Math.log10(n)) - 2); return Math.round(n / p) * p; };
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

const TOPICS = ['Budget Phone', 'Mechanical Keyboard', 'Gaming Laptop', 'Smartwatch', 'Wireless Earbuds', 'Desk Setup', 'Mirrorless Camera', 'Tablet', 'Home Office', 'AI Tools'];
const TEMPLATES = [
  'I Tested {n} {t}s So You Don\'t Have To',
  '{t} Review: Is It Worth It in 2026?',
  'Why Everyone Is WRONG About the {t}',
  'The Best {t} Under $' + '{p}',
  '{t} vs {t2}: Which Should You Buy?',
  'How to Choose a {t} (Beginner Guide)',
  '{n} {t} Tips Nobody Tells You',
  'I Used a {t} for 30 Days. Here\'s What Happened',
  'Don\'t Buy a {t} Until You Watch This',
  'My {t} Setup | Full Tour',
  'Is the Cheapest {t} Any Good?',
  '{t} Mistakes Beginners Make',
  'This {t} Changed Everything 🤯',
  'Unboxing the New {t} [First Impressions]',
];
const SHORT_TEMPLATES = ['{t} hack you need to try', 'Wait for it… {t} edition', 'Rating {t}s in 30 seconds', '{t} in 60 seconds #shorts'];

function fill(tpl, r, topic) {
  return tpl
    .replaceAll('{t2}', pick(r, TOPICS.filter((x) => x !== topic)))
    .replaceAll('{t}', topic)
    .replaceAll('{n}', String(pick(r, [3, 5, 7, 10, 12])))
    .replaceAll('{p}', String(pick(r, [50, 100, 200, 500, 1000])));
}

function iso(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `PT${h ? h + 'H' : ''}${m ? m + 'M' : ''}${s || (!h && !m) ? s + 'S' : ''}`;
}

const thumb = (label, seed) => {
  const hue = seed % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="hsl(${hue} 45% 32%)"/><text x="160" y="98" font-family="sans-serif" font-size="22" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return { medium: { url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` }, default: { url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` } };
};

export class DemoClient {
  constructor({ now = Date.now() } = {}) {
    this.now = now;
    this.channels = new Map(); // id -> { name, seed }
    this.videos = new Map(); // id -> generated video item (for getVideos)
    this.quotaUsed = 0;
    this.searchCalls = 0;
  }

  #register(name) {
    const clean = String(name).replace(/^@/, '').trim() || 'Demo Channel';
    const seed = hash(clean.toLowerCase());
    const id = 'UC' + makeId(seed, 22);
    if (!this.channels.has(id)) this.channels.set(id, { name: clean, seed });
    return id;
  }

  async resolveChannelId(input) {
    const p = parseChannelInput(input);
    if (!p) throw Object.assign(new Error('Please enter a channel.'), { status: 400 });
    if (p.type === 'id' && this.channels.has(p.value)) return p.value;
    return this.#register(p.value);
  }

  #channelItem(id) {
    const { name, seed } = this.channels.get(id);
    const r = rng(seed);
    const subs = Math.round(10 ** (4 + r() * 2.6));
    const videoCount = 80 + Math.floor(r() * 900);
    return {
      id,
      snippet: {
        title: name,
        customUrl: '@' + name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        description: `Synthetic demo channel "${name}". Not real data.`,
        publishedAt: new Date(this.now - (2 + r() * 8) * 365 * 86_400_000).toISOString(),
        thumbnails: thumb(name.slice(0, 2).toUpperCase(), seed),
        country: pick(r, ['US', 'IN', 'GB', 'CA']),
      },
      statistics: {
        subscriberCount: String(sig3(subs)),
        viewCount: String(Math.round(subs * (40 + r() * 200))),
        videoCount: String(videoCount),
        hiddenSubscriberCount: false,
      },
      brandingSettings: { channel: { keywords: '"tech reviews" gadgets "budget tech" unboxing' } },
      contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
    };
  }

  async getChannels(ids) {
    return [...new Set(ids)].filter((id) => this.channels.has(id)).map((id) => this.#channelItem(id));
  }

  #videosFor(id, max, topicHint) {
    const ch = this.#channelItem(id);
    const { seed } = this.channels.get(id);
    const r = rng(seed ^ 0x9e3779b9);
    const subs = Number(ch.statistics.subscriberCount);
    const perWeek = 0.7 + r() * 4;
    const shortsRatio = r() * 0.5;
    const bestDay = Math.floor(r() * 7);
    const hour = 12 + Math.floor(r() * 8);
    const total = Math.min(max, Number(ch.statistics.videoCount));
    const items = [];
    let t = this.now - r() * 3 * 86_400_000;
    for (let i = 0; i < total; i++) {
      const isShort = r() < shortsRatio;
      const topic = topicHint || pick(r, TOPICS);
      const title = fill(pick(r, isShort ? SHORT_TEMPLATES : TEMPLATES), r, topic);
      const d = new Date(t);
      d.setUTCHours(hour + Math.floor(r() * 3), Math.floor(r() * 60), 0, 0);
      const ageDays = Math.max((this.now - d.getTime()) / 86_400_000, 0.2);
      const growth = Math.min(1, Math.log10(1 + ageDays) / 1.5);
      let views = subs * (0.04 + r() * 0.12) * growth * (isShort ? 0.6 + r() * 2 : 1);
      if (d.getUTCDay() === bestDay) views *= 1.6;
      if (/\d/.test(title)) views *= 1.25;
      if (r() < 0.08) views *= 3 + r() * 7; // occasional breakout
      views = Math.round(views);
      const vid = makeId(seed + i * 7919, 11);
      items.push({
        id: vid,
        snippet: {
          publishedAt: d.toISOString(),
          channelId: id,
          channelTitle: ch.snippet.title,
          title,
          description: r() < 0.3
            ? `${title}. Synthetic demo video.`
            : `${title} — synthetic demo description. In this video we look at the ${topic.toLowerCase()} from every angle.\n\n0:00 Intro\n1:12 Design\n3:40 Performance\n6:05 Verdict\n\nGear I use: https://example.com/gear\n#${topic.replace(/\s+/g, '')} #tech`,
          thumbnails: thumb(isShort ? 'SHORT' : topic.split(' ')[0], seed + i),
          tags: [topic.toLowerCase(), 'tech', 'review', isShort ? 'shorts' : 'gadgets'],
          liveBroadcastContent: 'none',
        },
        statistics: {
          viewCount: String(views),
          likeCount: String(Math.round(views * (0.02 + r() * 0.04))),
          commentCount: String(Math.round(views * (0.001 + r() * 0.004))),
        },
        contentDetails: { duration: iso(isShort ? 15 + Math.floor(r() * 45) : 360 + Math.floor(r() * 1200)), caption: r() < 0.4 ? 'true' : 'false', definition: 'hd' },
      });
      this.videos.set(vid, items.at(-1));
      t -= (7 / perWeek) * 86_400_000 * (0.5 + r());
    }
    return items;
  }

  /** Look up videos by ID. Unknown IDs get a synthetic video on a demo channel. */
  async getVideos(ids) {
    return [...new Set(ids)].map((id) => {
      if (this.videos.has(id)) return this.videos.get(id);
      const chId = this.#register('Demo Channel');
      const pool = this.#videosFor(chId, 50);
      const v = { ...pool[hash(id) % pool.length], id };
      this.videos.set(id, v);
      return v;
    });
  }

  async getUploads(channel, max = 50) {
    const videos = this.#videosFor(channel.id, max);
    return { videos, complete: videos.length >= Number(channel.statistics.videoCount) };
  }

  async searchVideos(q, { max = 25 } = {}) {
    const r = rng(hash(q));
    const topic = q.replace(/\b\w/g, (c) => c.toUpperCase());
    const names = ['Gadget Lab', 'Tech Simplified', 'Budget Bytes', 'The Setup Guy', 'Pixel Pete', 'ReviewRoom', 'Desk Nerd', 'Circuit Daily'];
    const out = [];
    for (let i = 0; i < max; i++) {
      const id = this.#register(pick(r, names));
      const pool = this.#videosFor(id, 40, topic);
      const v = pool[Math.floor(r() * pool.length)];
      if (v) {
        const item = { ...v, id: makeId(hash(q) + i, 11) };
        this.videos.set(item.id, item);
        out.push(item);
      }
    }
    return out;
  }
}
