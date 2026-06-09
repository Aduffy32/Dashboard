const REDIRECT_URI = 'https://dashboard-zeta-brown-51.vercel.app';
const WHOOP_AUTH   = 'https://api.prod.whoop.com/oauth/oauth2/auth';

export default async function handler(req, res) {
  const { userId } = req.query || {};
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  const params = new URLSearchParams({
    client_id:     process.env.WHOOP_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'read:recovery read:sleep read:workout read:cycles read:body_measurement offline',
    state:         'whoop_' + userId,
  });

  return res.redirect(302, `${WHOOP_AUTH}?${params}`);
}
