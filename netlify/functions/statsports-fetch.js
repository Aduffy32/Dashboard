// StatSports APEX proxy — keeps the API key server-side (same pattern as
// whoop-fetch.js). This is a SCAFFOLD: StatSports does not publish technical API
// docs publicly, so the base URL, auth header and response shape below are
// best-guesses. When you get the real contract, fill in the three TODOs and the
// front-end (renderRuns / rnsNormalize in index.html) needs no changes.
//
// Netlify env vars to set:
//   STATSPORTS_API_KEY   — your key (e.g. H0948Qn9), never shipped to the browser
//   STATSPORTS_BASE      — API base URL (TODO: confirm with StatSports)
//
// Front-end flips on by setting RNS_USE_LIVE = true in index.html.

const API_KEY = process.env.STATSPORTS_API_KEY;
const BASE    = process.env.STATSPORTS_BASE; // TODO: e.g. 'https://api.statsports.com/v1'

function jsonResp(data, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

// Map our logical endpoint name → the real StatSports path.
// TODO: confirm the real paths once docs are available.
const ENDPOINT_MAP = {
  sessions: 'sessions',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResp({ error: 'method_not_allowed' }, 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResp({ error: 'invalid_body' }, 400); }

  if (!API_KEY || !BASE) {
    // Not wired yet — the front-end falls back to its sample data.
    return jsonResp({ error: 'not_configured', sessions: [] });
  }

  const path = ENDPOINT_MAP[body.endpoint] || body.endpoint || 'sessions';
  const url  = `${BASE.replace(/\/$/, '')}/${path}`;

  try {
    const res = await fetch(url, {
      headers: {
        // TODO: confirm the auth scheme. Common options:
        //   'Authorization': `Bearer ${API_KEY}`
        //   'X-Api-Key': API_KEY
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json',
      },
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }

    if (res.status >= 400) {
      console.error(`[statsports-fetch] ${res.status}: ${text.slice(0, 300)}`);
      return jsonResp({ error: 'statsports_api_error', status: res.status, sessions: [] });
    }

    // Normalize to { sessions: [...] } so the client always reads one shape.
    const sessions = Array.isArray(data) ? data : (data.sessions || data.data || []);
    return jsonResp({ sessions });
  } catch (err) {
    console.error('[statsports-fetch] fetch failed:', err);
    return jsonResp({ error: 'fetch_failed', sessions: [] });
  }
};
