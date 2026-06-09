const REDIRECT_URI = 'https://ajduffdash.netlify.app';
const WHOOP_AUTH   = 'https://api.prod.whoop.com/oauth/oauth2/auth';

exports.handler = async (event) => {
  const { userId } = event.queryStringParameters || {};
  if (!userId) {
    return { statusCode: 400, body: 'Missing userId' };
  }

  const params = new URLSearchParams({
    client_id:     process.env.WHOOP_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'read:recovery read:sleep read:workout read:cycles read:body_measurement offline',
    state:         'whoop_' + userId,
  });

  return {
    statusCode: 302,
    headers: { Location: `${WHOOP_AUTH}?${params}` },
  };
};
