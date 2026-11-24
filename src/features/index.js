// Feature modules. Each exports `create(ctx)` returning { routes?, start? }:
//   routes: { 'GET /api/...': async (url, req) => json, 'POST /api/...': ... }  (POST bodies: await ctx.readJson(req))
//   start(): begin background jobs (called once after the server starts unless DISABLE_SCHEDULER=1)
// ctx: { env, DEMO, client, store, tracker, oauth, channelAnalytics, events, meta, readJson, httpError, intParam, regionParam, log }
import { create as ai } from './ai.js';
import { create as audit } from './audit.js';
import { create as ranks } from './ranks.js';
import { create as alerts } from './alerts.js';

export const FEATURES = [ai, audit, ranks, alerts];
