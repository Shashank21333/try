// Feature: AI Studio. Claude-powered title, description, idea and script-outline generators,
// grounded in real YouTube data (autocomplete + competitor outliers). See src/ai.js.
//
// The official Anthropic SDK is imported lazily, so TubeScout still runs without node_modules;
// AI endpoints then answer 503 "Run npm install to enable AI features".
import {
  DEFAULT_MODEL, SETUP_MESSAGE, SDK_MISSING_MESSAGE, REQUEST_DEADLINE_MS, aiEnabled, loadSdk, createAI, clientOptions,
  parseTitlesInput, parseDescriptionInput, parseIdeasInput, parseScriptInput,
  generateTitles, generateDescription, generateIdeas, generateScript,
} from '../ai.js';

const MAX_IN_FLIGHT = 3; // concurrent generations; each one is billed by Anthropic

/**
 * @param ctx  feature context (see src/features/index.js)
 * @param overrides  tests only: { anthropicClient, sdk, fetchImpl, importer }
 */
export function create(ctx, overrides = {}) {
  const { env, httpError } = ctx;
  const model = (env.AI_MODEL || '').trim() || DEFAULT_MODEL;
  let sdkPromise = null;
  let ai = null;
  let inFlight = 0;

  const getSdk = () => {
    if ('sdk' in overrides) return Promise.resolve(overrides.sdk);
    sdkPromise ||= loadSdk(overrides.importer);
    return sdkPromise;
  };

  async function getAI() {
    if (!aiEnabled(env)) throw httpError(400, SETUP_MESSAGE);
    if (ai) return ai;
    const Anthropic = await getSdk();
    if (overrides.anthropicClient) {
      ai = createAI({ client: overrides.anthropicClient, model, sdk: Anthropic });
      return ai;
    }
    if (!Anthropic) throw httpError(503, SDK_MISSING_MESSAGE);
    // Credentials: ANTHROPIC_API_KEY from TubeScout's env (.env), else the SDK's own resolution
    // (e.g. an `ant auth login` profile when AI_ENABLED=1). The key is never logged or returned.
    // clientOptions + createAI cap one generation at REQUEST_DEADLINE_MS in total, retries included
    // (the SDK default would be a 10-minute timeout per attempt, retried twice).
    const client = new Anthropic(clientOptions(env));
    ai = createAI({ client, model, sdk: Anthropic, deadlineMs: REQUEST_DEADLINE_MS });
    return ai;
  }

  /** Wrap a POST handler: AI enabled -> SDK -> input validation -> concurrency guard -> generate. */
  const post = (parse, run) => async (url, req) => {
    const body = await ctx.readJson(req);
    const engine = await getAI();
    const input = parse(body);
    if (inFlight >= MAX_IN_FLIGHT) throw httpError(429, 'Too many AI generations are running at once. Wait for one to finish.');
    inFlight += 1;
    try {
      return await run(engine, input);
    } finally {
      inFlight -= 1;
    }
  };

  const deps = { client: ctx.client, tracker: ctx.tracker, demo: ctx.DEMO, fetchImpl: overrides.fetchImpl };

  return {
    routes: {
      'GET /api/ai/status': async () => ({
        enabled: aiEnabled(env),
        model,
        sdkInstalled: overrides.anthropicClient ? true : Boolean(await getSdk()),
        timeoutSeconds: REQUEST_DEADLINE_MS / 1000, // the UI tells users how long it will wait at most
      }),
      'POST /api/ai/titles': post(parseTitlesInput, (engine, input) => generateTitles(engine, deps, input)),
      'POST /api/ai/description': post(parseDescriptionInput, (engine, input) => generateDescription(engine, input)),
      'POST /api/ai/ideas': post(parseIdeasInput, (engine, input) => generateIdeas(engine, deps, input)),
      'POST /api/ai/script': post(parseScriptInput, (engine, input) => generateScript(engine, input)),
    },
  };
}
