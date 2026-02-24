/**
 * Strava POC — Cloudflare Worker
 *
 * Routes:
 *   GET  /auth/callback  — OAuth authorization-code → token exchange
 *   GET  /webhook        — Strava hub verification challenge
 *   POST /webhook        — Strava event ingestion
 *   GET  /activities     — Return in-memory cached running activities
 *
 * Required env vars (set via `wrangler secret put` or the dashboard):
 *   STRAVA_CLIENT_ID      – Your Strava app's client ID
 *   STRAVA_CLIENT_SECRET  – Your Strava app's client secret
 *   STRAVA_VERIFY_TOKEN   – Arbitrary secret used when registering the webhook
 *   STRAVA_ACCESS_TOKEN   – A pre-authorized Strava access token used by the
 *                           webhook handler to fetch activity details server-side
 *   FRONTEND_URL          – Base URL of the frontend SPA (e.g. https://your-app.pages.dev)
 *
 * ⚠️  POC limitations:
 *   - `cachedActivities` is module-level → wiped on every cold start / isolate recycle.
 *   - `STRAVA_ACCESS_TOKEN` is a single shared token; not suitable for multi-user use.
 *   - No token refresh logic. Rotate via env var when it expires.
 */

// ---------------------------------------------------------------------------
// In-memory activity cache — intentionally volatile (POC only)
// ---------------------------------------------------------------------------
const cachedActivities = [];

// ---------------------------------------------------------------------------
// CORS headers returned on every response that the browser fetches directly
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ---------------------------------------------------------------------------
// Worker entry-point
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    // Handle CORS pre-flight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (pathname === '/auth/callback' && method === 'GET') {
        return await handleAuthCallback(request, env);
      }

      if (pathname === '/webhook' && method === 'GET') {
        return handleWebhookVerification(request, env);
      }

      if (pathname === '/webhook' && method === 'POST') {
        return await handleWebhookEvent(request, env);
      }

      if (pathname === '/activities' && method === 'GET') {
        return handleGetActivities();
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('Unhandled error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// GET /auth/callback
// Exchanges the authorization code Strava appended to the redirect URL for an
// access token, then sends the browser back to the frontend SPA with a minimal
// token payload embedded in the URL fragment (never in the query string).
// ---------------------------------------------------------------------------
async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return errorRedirect(env, `oauth_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return new Response('Missing "code" parameter', { status: 400 });
  }

  const tokenRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error('Token exchange failed:', tokenRes.status, body);
    return errorRedirect(env, `oauth_error=${encodeURIComponent('token_exchange_failed')}`);
  }

  const tokenData = await tokenRes.json();

  // Minimal payload — only what the browser needs to identify the athlete and
  // authenticate subsequent calls to /activities.
  const payload = {
    athlete_id: tokenData.athlete?.id,
    athlete_name: tokenData.athlete
      ? `${tokenData.athlete.firstname} ${tokenData.athlete.lastname}`.trim()
      : null,
    access_token: tokenData.access_token,
    expires_at: tokenData.expires_at,
  };

  // Embed payload in the URL fragment so it is never sent to any server.
  const frontendBase = (env.FRONTEND_URL || '').replace(/\/$/, '');
  const redirectUrl = `${frontendBase}/#token=${encodeURIComponent(JSON.stringify(payload))}`;
  return Response.redirect(redirectUrl, 302);
}

// ---------------------------------------------------------------------------
// GET /webhook
// Responds to Strava's subscription verification challenge.
// Strava sends: hub.mode=subscribe, hub.verify_token, hub.challenge
// ---------------------------------------------------------------------------
function handleWebhookVerification(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const verifyToken = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode !== 'subscribe' || verifyToken !== env.STRAVA_VERIFY_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }

  // Must respond with exactly this shape within 2 seconds.
  return new Response(JSON.stringify({ 'hub.challenge': challenge }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// POST /webhook
// Receives Strava activity events, fetches the full activity, applies the
// running filter, and caches the result in memory.
// ---------------------------------------------------------------------------
async function handleWebhookEvent(request, env) {
  let event;
  try {
    event = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // Strava also sends athlete events (deauthorize etc.) — ignore them.
  if (event.object_type !== 'activity') {
    return new Response('OK', { status: 200 });
  }

  // Only care about newly created or updated activities.
  if (!['create', 'update'].includes(event.aspect_type)) {
    return new Response('OK', { status: 200 });
  }

  const activityId = event.object_id;

  // We need a server-side access token to fetch the activity. For this POC
  // this is a single pre-authorized token stored as an env var.
  if (!env.STRAVA_ACCESS_TOKEN) {
    console.error('STRAVA_ACCESS_TOKEN not configured — cannot fetch activity details');
    return new Response('OK', { status: 200 });
  }

  const activityRes = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}`,
    { headers: { Authorization: `Bearer ${env.STRAVA_ACCESS_TOKEN}` } }
  );

  if (!activityRes.ok) {
    console.error(`Failed to fetch activity ${activityId}: HTTP ${activityRes.status}`);
    return new Response('OK', { status: 200 });
  }

  const activity = await activityRes.json();

  // Running filter — check both fields to handle older API responses that only
  // populate the deprecated `type` field instead of the newer `sport_type`.
  const isRun =
    activity.sport_type === 'Run' ||
    activity.sport_type === 'TrailRun' ||
    activity.type === 'Run';

  if (!isRun) {
    return new Response('OK', { status: 200 });
  }

  // For update events replace the existing cached entry; for create just push.
  if (event.aspect_type === 'update') {
    const idx = cachedActivities.findIndex((a) => a.id === activityId);
    if (idx !== -1) {
      cachedActivities[idx] = activity;
      return new Response('OK', { status: 200 });
    }
  }

  cachedActivities.push(activity);
  return new Response('OK', { status: 200 });
}

// ---------------------------------------------------------------------------
// GET /activities
// Returns the current in-memory cache as JSON.
// ⚠️  Resets to [] on every cold start.
// ---------------------------------------------------------------------------
function handleGetActivities() {
  return jsonResponse(cachedActivities);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function errorRedirect(env, queryParam) {
  const frontendBase = (env.FRONTEND_URL || '').replace(/\/$/, '');
  return Response.redirect(`${frontendBase}/?${queryParam}`, 302);
}
