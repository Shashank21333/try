// Feature: alerts. Turns tracker snapshots ('snapshot' events) and rank checks ('ranks' events) into an
// in-app feed and optional Telegram / Discord / Slack / webhook messages. Logic lives in src/alerts.js.
import { AlertManager } from '../alerts.js';

export function create(ctx) {
  const alerts = new AlertManager({ store: ctx.store, env: ctx.env, demo: ctx.DEMO, log: ctx.log });

  // Listeners never throw: a failing alert must not break snapshots or rank checks.
  const listen = (event, handler) => ctx.events.on(event, (payload) => {
    Promise.resolve().then(() => handler(payload))
      .catch((e) => ctx.log(`Alerts: could not process '${event}' event: ${e.message}`));
  });
  listen('snapshot', (p) => alerts.handleSnapshot(p));
  listen('ranks', (p) => alerts.handleRanks(p));

  return {
    routes: {
      'GET /api/alerts': async (url) => {
        const limit = ctx.intParam(url.searchParams.get('limit'), 50, 1, 500);
        const [list, settings] = await Promise.all([alerts.list({ limit }), alerts.getSettings()]);
        return { ...list, settings, delivery: alerts.deliveryStatus(), meta: ctx.meta() };
      },

      'POST /api/alerts/read': async (url, req) => {
        const body = await ctx.readJson(req);
        if (body?.all === true) return alerts.markRead({ all: true });
        const ids = body?.ids;
        if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((id) => typeof id === 'string' && id.length <= 100)) {
          throw ctx.httpError(400, 'Send { "ids": ["..."] } or { "all": true }.');
        }
        return alerts.markRead({ ids });
      },

      'POST /api/alerts/settings': async (url, req) => ({ settings: await alerts.saveSettings(await ctx.readJson(req)) }),

      'POST /api/alerts/test': async (url, req) => {
        await ctx.readJson(req);
        return { ...(await alerts.sendTest()), delivery: alerts.deliveryStatus() };
      },

      'POST /api/alerts/clear': async (url, req) => {
        await ctx.readJson(req);
        return alerts.clear();
      },
    },
  };
}
