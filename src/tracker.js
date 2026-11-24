// Daily snapshots of tracked channels -> growth history, trending videos and new-upload alerts.
// Cost: ~3 API units per channel per snapshot (channels + playlistItems + videos).
import { normalizeVideo, median } from './analytics.js';

const DAY = 86_400_000;
export const MAX_TRACKED = 25;
const MAX_SNAPSHOTS = 400; // ~13 months of daily history per channel
const VIDEOS_PER_SNAPSHOT = 30;

const snapKey = (id) => `snap-${id.replace(/[^\w-]/g, '')}`;

export class Tracker {
  constructor({ client, store, now = () => Date.now(), log = () => {}, onSnapshot = null }) {
    this.client = client;
    this.store = store;
    this.now = now;
    this.log = log;
    this.onSnapshot = onSnapshot; // ({ channel, snapshots, report }) after every snapshot (used by alerts)
    this.running = null;
  }

  list() {
    return this.store.read('tracked', []);
  }

  async add(input) {
    const id = await this.client.resolveChannelId(input);
    const [raw] = await this.client.getChannels([id]);
    if (!raw) throw Object.assign(new Error(`Channel not found: ${input}`), { status: 404 });
    let added = false;
    await this.store.update('tracked', [], (list) => {
      if (list.some((c) => c.id === id)) return list;
      if (list.length >= MAX_TRACKED) throw Object.assign(new Error(`You can track up to ${MAX_TRACKED} channels.`), { status: 400 });
      added = true;
      return [...list, {
        id,
        title: raw.snippet?.title || id,
        handle: raw.snippet?.customUrl || null,
        thumbnail: raw.snippet?.thumbnails?.default?.url || null,
        addedAt: new Date(this.now()).toISOString(),
      }];
    });
    if (added) await this.snapshot(id, raw);
    return { id, added };
  }

  async remove(id) {
    await this.store.update('tracked', [], (list) => list.filter((c) => c.id !== id));
    await this.store.remove(snapKey(id));
  }

  async snapshot(id, rawChannel) {
    const raw = rawChannel || (await this.client.getChannels([id]))[0];
    if (!raw) throw new Error(`Channel ${id} no longer available`);
    const t = this.now();
    const { videos } = await this.client.getUploads(raw, VIDEOS_PER_SNAPSHOT);
    const st = raw.statistics || {};
    const snap = {
      t,
      subs: st.hiddenSubscriberCount ? null : Number(st.subscriberCount ?? NaN),
      views: Number(st.viewCount ?? NaN),
      videoCount: Number(st.videoCount ?? NaN),
      videos: videos.map((v) => normalizeVideo(v, t)).map((v) => ({
        id: v.id, title: v.title, publishedAt: v.publishedAt, views: v.views, likes: v.likes,
        comments: v.comments, isShort: v.isShort, thumbnail: v.thumbnail,
      })),
    };
    const all = await this.store.update(snapKey(id), [], (list) => [...list, snap].slice(-MAX_SNAPSHOTS));
    // keep display info fresh
    await this.store.update('tracked', [], (list) => list.map((c) => (c.id === id
      ? { ...c, title: raw.snippet?.title || c.title, thumbnail: raw.snippet?.thumbnails?.default?.url || c.thumbnail }
      : c)));
    if (this.onSnapshot) {
      try {
        const channel = (await this.list()).find((c) => c.id === id) || { id, title: raw.snippet?.title || id };
        await this.onSnapshot({ channel, snapshots: all, report: channelReport(all) });
      } catch (e) { this.log(`onSnapshot hook failed: ${e.message}`); }
    }
    return snap;
  }

  /** Snapshot every tracked channel whose latest snapshot is older than minHours. */
  async runDue({ minHours = 20, force = false } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      const results = [];
      for (const c of await this.list()) {
        const snaps = await this.store.read(snapKey(c.id), []);
        const last = snaps.at(-1)?.t ?? 0;
        if (!force && this.now() - last < minHours * 3600_000) continue;
        try {
          await this.snapshot(c.id);
          results.push({ id: c.id, ok: true });
        } catch (e) {
          this.log(`Snapshot failed for ${c.title}: ${e.message}`);
          results.push({ id: c.id, ok: false, error: e.message });
        }
      }
      return results;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async report() {
    const tracked = await this.list();
    const channels = [];
    const trending = [];
    const newUploads = [];
    for (const c of tracked) {
      const snaps = await this.store.read(snapKey(c.id), []);
      if (!snaps.length) { channels.push({ ...c, snapshots: 0 }); continue; }
      const r = channelReport(snaps);
      channels.push({ ...c, ...r.summary });
      trending.push(...r.trending.map((v) => ({ ...v, channelId: c.id, channelTitle: c.title })));
      newUploads.push(...r.newUploads.map((v) => ({ ...v, channelId: c.id, channelTitle: c.title })));
    }
    return {
      channels,
      trending: trending.sort((a, b) => b.ratio - a.ratio).slice(0, 20),
      newUploads: newUploads.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 30),
    };
  }
}

/** Find the newest snapshot taken at least `ms` before the latest one (or the oldest available). */
function baseline(snaps, ms) {
  const latest = snaps.at(-1);
  for (let i = snaps.length - 2; i >= 0; i--) if (latest.t - snaps[i].t >= ms) return { snap: snaps[i], partial: false };
  return snaps.length > 1 ? { snap: snaps[0], partial: true } : null;
}

export function channelReport(snaps) {
  const latest = snaps.at(-1);
  const delta = (days) => {
    const b = baseline(snaps, days * DAY - 6 * 3600_000); // tolerate snapshots a few hours early
    if (!b) return null;
    const dtDays = (latest.t - b.snap.t) / DAY;
    return {
      subs: Number.isFinite(latest.subs) && Number.isFinite(b.snap.subs) ? latest.subs - b.snap.subs : null,
      views: latest.views - b.snap.views,
      videos: latest.videoCount - b.snap.videoCount,
      viewsPerDay: dtDays > 0 ? (latest.views - b.snap.views) / dtDays : null,
      sinceT: b.snap.t,
      partial: b.partial,
    };
  };

  // Trending: views gained per day since the previous snapshot (>= 12h earlier), vs the channel's median gain.
  const prevB = baseline(snaps, 12 * 3600_000);
  const trending = [];
  if (prevB) {
    const prev = prevB.snap;
    const prevViews = new Map(prev.videos.map((v) => [v.id, v.views]));
    const dtDays = (latest.t - prev.t) / DAY;
    const gains = latest.videos.map((v) => {
      const before = prevViews.get(v.id);
      if (before !== undefined) return { ...v, gainPerDay: (v.views - before) / dtDays, isNew: false };
      const ageDays = Math.max((latest.t - Date.parse(v.publishedAt)) / DAY, 1 / 24);
      return { ...v, gainPerDay: v.views / ageDays, isNew: true };
    });
    const typical = median(gains.filter((g) => !g.isNew).map((g) => g.gainPerDay));
    for (const g of gains) {
      const ratio = g.gainPerDay / Math.max(typical, 1);
      if (g.gainPerDay >= 50 && ratio >= 2) trending.push({ ...g, ratio, typicalGainPerDay: typical });
    }
  }

  const newUploads = latest.videos
    .filter((v) => latest.t - Date.parse(v.publishedAt) <= 7 * DAY)
    .map((v) => ({ ...v, viewsPerDay: v.views / Math.max((latest.t - Date.parse(v.publishedAt)) / DAY, 1 / 24) }));

  return {
    summary: {
      snapshots: snaps.length,
      firstT: snaps[0].t,
      lastT: latest.t,
      subscribers: latest.subs,
      views: latest.views,
      videoCount: latest.videoCount,
      d1: delta(1),
      d7: delta(7),
      d30: delta(30),
      series: snaps.map((s) => ({ t: s.t, subs: s.subs, views: s.views })),
    },
    trending,
    newUploads,
  };
}
