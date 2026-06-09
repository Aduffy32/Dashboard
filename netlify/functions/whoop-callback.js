const SUPABASE_URL = 'https://vffdvrfppadopcwhzjug.supabase.co';
const REDIRECT_URI = 'https://ajduffdash.netlify.app';

function jsonResp(data, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

async function supabaseUpsert(serviceKey, data) {
  console.log(`[whoop-callback] upserting tokens for user_id=${data.user_id}`);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/whoop_tokens?on_conflict=user_id`, {
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
    console.error(`[whoop-callback] upsert failed: ${res.status} ${body}`);
    throw new Error(`Supabase upsert failed: ${res.status} ${body}`);
  }
  console.log(`[whoop-callback] upsert success`);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return jsonResp({ error: 'invalid_body' }, 400);
  }

  const { code, userId } = body;
  if (!code || !userId) {
    return jsonResp({ error: 'missing_params' }, 400);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('[whoop-callback] SUPABASE_SERVICE_ROLE_KEY not set');
    return jsonResp({ error: 'server_config_error' }, 500);
  }

  try {
    console.log(`[whoop-callback] exchanging code for userId=${userId}`);
    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
        client_id:     process.env.WHOOP_CLIENT_ID,
        client_secret: process.env.WHOOP_CLIENT_SECRET,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('[whoop-callback] token exchange error:', tokenRes.status, errBody);
      const expired = tokenRes.status === 400 && errBody.includes('invalid_grant');
      return jsonResp({ error: expired ? 'code_expired' : 'token_exchange_failed' }, 502);
    }

    const { access_token, refresh_token, expires_in } = await tokenRes.json();
    console.log(`[whoop-callback] token exchange success, expires_in=${expires_in}`);
    const expires_at = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString();

    await supabaseUpsert(serviceKey, {
      user_id:       userId,
      access_token,
      refresh_token,
      expires_at,
      updated_at:    new Date().toISOString(),
    });

    return jsonResp({ success: true });
  } catch (err) {
    console.error('[whoop-callback] error:', err.message);
    return jsonResp({ error: err.message || 'callback_failed' }, 500);
  }
};
