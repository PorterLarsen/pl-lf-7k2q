// Cloudflare Pages Function: keeps your leads, stars, notes and settings in Cloudflare KV
// so every device and browser you log in from sees the same thing.
// GET  /api/sync            -> {configured, state, dataAt}
// GET  /api/sync?part=data  -> the saved lead list
// PUT  /api/sync            -> save state (body: payload)
// PUT  /api/sync?part=data  -> save lead list (body: data)
const json = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
const who = (req, env) => (req.headers.get('cf-access-authenticated-user-email') || (env.ALLOW_WITHOUT_ACCESS === 'yes' ? 'local' : '')).toLowerCase();

export async function onRequestGet({request, env}) {
  const u = who(request, env);
  if (!u) return json({error: 'login required'}, 401);
  if (!env.LEADS) return json({configured: false});
  if (new URL(request.url).searchParams.get('part') === 'data') {
    const d = await env.LEADS.get('syncdata:' + u);
    return new Response(d || 'null', {headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
  }
  const [st, meta] = await Promise.all([env.LEADS.get('syncstate:' + u, 'json'), env.LEADS.get('syncdatameta:' + u, 'json')]);
  return json({configured: true, state: st, dataAt: meta ? meta.fetchedAt : null});
}

export async function onRequestPut({request, env}) {
  const u = who(request, env);
  if (!u) return json({error: 'login required'}, 401);
  if (!env.LEADS) return json({error: 'KV binding LEADS is not set'}, 500);
  const text = await request.text();
  if (text.length > 20e6) return json({error: 'too large'}, 413);
  let body; try { body = JSON.parse(text); } catch (e) { return json({error: 'bad json'}, 400); }
  if (new URL(request.url).searchParams.get('part') === 'data') {
    if (!body || !body.fetchedAt) return json({error: 'missing data'}, 400);
    await env.LEADS.put('syncdata:' + u, text);
    await env.LEADS.put('syncdatameta:' + u, JSON.stringify({fetchedAt: body.fetchedAt}));
    return json({ok: true});
  }
  await env.LEADS.put('syncstate:' + u, JSON.stringify({...body, savedAt: Date.now()}));
  return json({ok: true});
}
