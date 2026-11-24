// Feature: Rankings. Daily YouTube search rank tracking for (keyword, channel[, region]) pairs.
// Logic lives in src/ranks.js; this file validates input and wires routes + the hourly job.
//
// Cost per check: one search.list call (up to 50 results) + one videos.list call (1 unit) for details.
// Checks are capped by RANK_MAX_CHECKS_PER_DAY (default 20) per rolling 24 hours, manual + automatic.
// After every conclusive check the 'ranks' event is emitted on ctx.events (consumed by the Alerts feature).
import { RankTracker, KEYWORD_MAX, DEFAULT_MAX_CHECKS_PER_DAY, RECHECK_MIN_MS, isItemId, normalizeKeyword } from '../ranks.js';

/** @param {object} ctx  see src/features/index.js. `opts.now` is for tests (fake clock). */
export function create(ctx, { now } = {}) {
  const { httpError, readJson, meta, env } = ctx;
  const ranks = new RankTracker({
    client: ctx.client,
    store: ctx.store,
    events: ctx.events,
    maxChecksPerDay: ctx.intParam(env.RANK_MAX_CHECKS_PER_DAY, DEFAULT_MAX_CHECKS_PER_DAY, 0, 1000),
    log: ctx.log,
    ...(now ? { now } : {}),
  });
  const autoChecks = env.DISABLE_SCHEDULER !== '1';

  const withQuota = async (body) => ({ ...body, ...(await ranks.quota()) });

  // readJson accepts any JSON value; `null`, arrays and numbers must be a 400, not a TypeError (500).
  const readObject = async (req) => {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Expected a JSON object.');
    return body;
  };

  const idFrom = (body) => {
    const id = body?.id;
    if (!isItemId(id)) throw httpError(400, 'Missing or invalid ranking id.');
    return id;
  };

  return {
    ranks, // exposed for tests
    start: () => ranks.start(),
    routes: {
      'GET /api/ranks': async () => withQuota({ items: await ranks.reports(), autoChecks, meta: meta() }),

      'POST /api/ranks': async (url, req) => {
        const body = await readObject(req);
        const keyword = normalizeKeyword(body.keyword);
        if (!keyword) throw httpError(400, 'Enter a keyword to track.');
        if (keyword.length > KEYWORD_MAX) throw httpError(400, `Keywords can be at most ${KEYWORD_MAX} characters.`);
        const channel = typeof body.channel === 'string' ? body.channel.trim() : '';
        if (!channel) throw httpError(400, 'Enter the channel to look for (URL, @handle or channel ID).');
        if (channel.length > 300) throw httpError(400, 'That channel input is too long.');
        const rawRegion = typeof body.region === 'string' ? body.region.trim() : '';
        const region = rawRegion ? ctx.regionParam(rawRegion) : null;
        if (rawRegion && !region) throw httpError(400, 'Region must be a 2-letter country code such as US, GB or IN.');

        const channelId = await ctx.client.resolveChannelId(channel);
        const [raw] = await ctx.client.getChannels([channelId]);
        if (!raw) throw httpError(404, `Channel not found: ${channel}`);
        const item = await ranks.add({ keyword, region, channel: { id: channelId, title: raw.snippet?.title } });

        // First check right away. If it fails (daily cap, API error) the item stays and is retried by the daily job.
        let checkError = null;
        try { await ranks.check(item); } catch (e) { checkError = e.message; }
        return withQuota({ added: true, item: await ranks.report(item.id), checkError });
      },

      'POST /api/ranks/remove': async (url, req) => {
        const id = idFrom(await readObject(req));
        if (!(await ranks.remove(id))) throw httpError(404, 'That ranking is not being tracked.');
        return { ok: true };
      },

      'POST /api/ranks/check': async (url, req) => {
        const body = await readObject(req);
        if (body.id === undefined || body.id === null || body.id === '') {
          // Check everything that is due (last check older than ~20h).
          const run = await ranks.runDue();
          const firstError = run.results.find((r) => r.error);
          if (run.due && !run.results.some((r) => !r.error) && firstError) throw httpError(firstError.status, firstError.error);
          return withQuota(run);
        }
        const id = idFrom(body);
        const item = await ranks.get(id);
        if (!item) throw httpError(404, 'That ranking is not being tracked.');
        const before = await ranks.report(id);
        const age = before.lastChecked === null ? Infinity : ranks.now() - before.lastChecked;
        if (age < RECHECK_MIN_MS) {
          // The YouTube client caches identical searches for 15 minutes, so a new check would only repeat this one.
          const when = age < 60_000 ? 'just now' : `${Math.round(age / 60_000)} min ago`;
          return withQuota({
            checked: false,
            item: before,
            message: `Checked ${when}. Search results are cached for 15 minutes, so checking again now would return the same result. No check was used.`,
          });
        }
        await ranks.check(item);
        return withQuota({ checked: true, item: await ranks.report(id) });
      },
    },
  };
}
