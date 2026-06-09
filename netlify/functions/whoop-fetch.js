const SUPABASE_URL = 'https://vffdvrfppadopcwhzjug.supabase.co';
const WHOOP_BASE   = 'https://api.prod.whoop.com/developer/v2';

const ENDPOINT_MAP = {
  sleep:    'activity/sleep',
  cycle:    'cycle',
  recovery: 'recovery',
  workout:  'activity/workout',
};

function jsonResp(data, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

async function supabaseSelect(serviceKey, userId) {
  const url = `${SUPABASE_URL}/rest/v1/whoop_tokens?user_id=eq.${encodeURIComponent(userId)}&select=access_token,refresh_token,expires_at&limit=1`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey':        serviceKey,
    },
  });
  if (!res.ok) throw new Error(`Supabase select failed: ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function supabaseUpsert(serviceKey, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/whoop_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${serviceKey}`,
      'apikey':        serviceKey,
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${body}`);
  }
}

async function doRefresh(serviceKey, userId, refreshToken) {
  const res = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     process.env.WHOOP_CLIENT_ID,
      client_secret: process.env.WHOOP_CLIENT_SECRET,
    }).toString(),
  });

  if (!res.ok) throw new Error('refresh_failed');

  const { access_token, refresh_token: newRefresh, expires_in } = await res.json();
  const expires_at = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString();

  await supabaseUpsert(serviceKey, {
    user_id:       userId,
    access_token,
    refresh_token: newRefresh || refreshToken,
    expires_at,
    updated_at:    new Date().toISOString(),
  });

  return access_token;
}

async function whoopGet(endpoint, accessToken) {
  const [name, qs] = endpoint.split('?');
  const mapped = ENDPOINT_MAP[name] ?? name;
  const resolved = qs ? `${mapped}?${qs}` : mapped;
  const url = `${WHOOP_BASE}/${resolved}`;
  console.log(`[whoop-fetch] GET ${url}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  let rawText, data;
  try {
    rawText = await res.text();
    data = JSON.parse(rawText);
  } catch {
    data = {};
    rawText = rawText ?? '';
  }
  if (res.status >= 400) console.log(`[whoop-fetch] ${res.status} body: ${rawText.slice(0, 300)}`);
  return { status: res.status, data };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return jsonResp({ error: 'invalid_body' }, 400);
  }

  const { userId, endpoint } = body;
  if (!userId || !endpoint) {
    return jsonResp({ error: 'missing_params' }, 400);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    return jsonResp({ error: 'server_config_error' }, 500);
  }

  let tokenRow;
  try {
    tokenRow = await supabaseSelect(serviceKey, userId);
  } catch (err) {
    console.error('Token lookup error:', err);
    return jsonResp({ error: 'not_connected' });
  }

  if (!tokenRow) {
    return jsonResp({ error: 'not_connected' });
  }

  let { access_token, refresh_token, expires_at } = tokenRow;

  // Proactive refresh if token expires within 60 seconds
  if (new Date(expires_at) < new Date(Date.now() + 60000)) {
    try {
      access_token = await doRefresh(serviceKey, userId, refresh_token);
    } catch {
      return jsonResp({ error: 'reauth_required' });
    }
  }

  let { status, data } = await whoopGet(endpoint, access_token);

  // Reactive refresh on 401
  if (status === 401) {
    try {
      access_token = await doRefresh(serviceKey, userId, refresh_token);
      ({ status, data } = await whoopGet(endpoint, access_token));
    } catch {
      return jsonResp({ error: 'reauth_required' });
    }
  }

  if (status === 404) {
    // Whoop returns 404 when no data exists for this endpoint yet (e.g. no sleep tracked).
    return jsonResp({ records: [] });
  }

  if (status >= 400) {
    console.error(`Whoop API error ${status} for ${endpoint}:`, data);
    return jsonResp({ error: 'whoop_api_error', status });
  }

  return jsonResp(data);
};
