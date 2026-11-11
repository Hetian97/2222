// Cloudflare Worker: WeRead Agent API proxy.
// Required secret: WEREAD_API_KEY (wrk-...)
// Optional secret: APP_TOKEN (simple client access gate)
// Optional vars: ALLOWED_ORIGIN (default *), WEREAD_SKILL_VERSION (default 1.0.5)

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/api/weread/health') {
      return json({ ok: true, configured: !!env.WEREAD_API_KEY }, 200, corsHeaders);
    }

    if (url.pathname !== '/' && url.pathname !== '/api/weread') {
      return json({ ok: false, error: 'Not found' }, 404, corsHeaders);
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'POST required' }, 405, corsHeaders);
    }

    if (!env.WEREAD_API_KEY) {
      return json({ ok: false, error: 'WEREAD_API_KEY is not configured' }, 500, corsHeaders);
    }

    if (env.APP_TOKEN && request.headers.get('X-App-Token') !== env.APP_TOKEN) {
      return json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ ok: false, error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    if (!body || typeof body.api_name !== 'string' || !body.api_name.startsWith('/')) {
      return json({ ok: false, error: 'api_name is required' }, 400, corsHeaders);
    }

    const upstreamBody = {
      ...body,
      skill_version: body.skill_version || env.WEREAD_SKILL_VERSION || '1.0.5'
    };

    try {
      const upstream = await fetch('https://i.weread.qq.com/api/agent/gateway', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WEREAD_API_KEY}`
        },
        body: JSON.stringify(upstreamBody)
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: {
          ...corsHeaders,
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8'
        }
      });
    } catch (error) {
      return json({ ok: false, error: error.message || String(error) }, 502, corsHeaders);
    }
  }
};

function json(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
  });
}
