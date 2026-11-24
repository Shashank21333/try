// Google OAuth 2.0 (authorization-code flow) for connecting the user's own channel.
// Tokens are stored locally in data/oauth.json with 0600 permissions.
import { randomBytes } from 'node:crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const SCOPES = {
  youtube: 'https://www.googleapis.com/auth/youtube.readonly',
  analytics: 'https://www.googleapis.com/auth/yt-analytics.readonly',
  revenue: 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
};

export class GoogleOAuth {
  constructor({ clientId, clientSecret, redirectUri, includeRevenue = false, store, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.scopes = [SCOPES.youtube, SCOPES.analytics, ...(includeRevenue ? [SCOPES.revenue] : [])];
    this.store = store;
    this.fetch = fetchImpl;
    this.now = now;
    this.pendingStates = new Map();
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  authUrl() {
    const state = randomBytes(24).toString('base64url');
    this.pendingStates.set(state, this.now() + 10 * 60_000);
    for (const [s, exp] of this.pendingStates) if (exp < this.now()) this.pendingStates.delete(s);
    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return u.toString();
  }

  consumeState(state) {
    const exp = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    return Boolean(exp && exp >= this.now());
  }

  async #tokenRequest(params) {
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Google sign-in failed: ${body.error_description || body.error || res.status}`);
      err.status = body.error === 'invalid_grant' ? 401 : 502;
      throw err;
    }
    return body;
  }

  async handleCallback({ code, state }) {
    if (!this.consumeState(state)) throw Object.assign(new Error('Sign-in link expired or was tampered with. Please try again.'), { status: 400 });
    const t = await this.#tokenRequest({ code, redirect_uri: this.redirectUri, grant_type: 'authorization_code' });
    const tokens = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      scope: t.scope,
      expires_at: this.now() + (Number(t.expires_in) || 3600) * 1000,
    };
    await this.store.write('oauth', tokens, { mode: 0o600 });
    return tokens;
  }

  async getAccessToken() {
    const tokens = await this.store.read('oauth', null);
    if (!tokens) return null;
    if (tokens.access_token && tokens.expires_at - 60_000 > this.now()) return tokens.access_token;
    if (!tokens.refresh_token) return null;
    try {
      const t = await this.#tokenRequest({ refresh_token: tokens.refresh_token, grant_type: 'refresh_token' });
      const updated = { ...tokens, access_token: t.access_token, expires_at: this.now() + (Number(t.expires_in) || 3600) * 1000, scope: t.scope || tokens.scope };
      await this.store.write('oauth', updated, { mode: 0o600 });
      return updated.access_token;
    } catch (e) {
      if (e.status === 401) await this.store.remove('oauth'); // refresh token revoked or expired
      throw e;
    }
  }

  async grantedScopes() {
    const tokens = await this.store.read('oauth', null);
    return tokens?.scope ? tokens.scope.split(' ') : [];
  }

  async disconnect() {
    const tokens = await this.store.read('oauth', null);
    await this.store.remove('oauth');
    const token = tokens?.refresh_token || tokens?.access_token;
    if (token) {
      await this.fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  }
}
