// Cloudflare Pages Function: on-demand RentCast value + rent estimate for one property.
// Key: Cloudflare secret RENTCAST_API_KEY. KV binding LEADS (optional) caches results for 180 days
// and enforces RENTCAST_MONTHLY_CAP calls per month (default 48, under the free plan's 50).
const API = 'https://api.rentcast.io/v1';
const json = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
const month = () => new Date().toISOString().slice(0, 7);
const allowed = (req, env) => env.ALLOW_WITHOUT_ACCESS === 'yes' || !!req.headers.get('cf-access-authenticated-user-email');
const SUBJ = ['propertyType', 'bedrooms', 'bathrooms', 'squareFootage', 'lotSize', 'yearBuilt', 'lastSaleDate', 'lastSalePrice'];
const pick = (o) => Object.fromEntries(SUBJ.map((k) => [k, (o || {})[k] ?? null]));
const comp = (c) => ({address: c.formattedAddress, price: c.price, sqft: c.squareFootage, bd: c.bedrooms, ba: c.bathrooms, built: c.yearBuilt,
  dist: c.distance, status: c.status, date: c.removedDate || c.listedDate, type: c.propertyType});

async function usage(env) {
  const cap = +(env.RENTCAST_MONTHLY_CAP || 48);
  if (!env.LEADS) return {used: 0, cap};
  return {used: +(await env.LEADS.get('rccount:' + month())) || 0, cap};
}

export async function onRequestGet({request, env}) {
  if (!allowed(request, env)) return json({error: 'login required'}, 401);
  return json({configured: !!env.RENTCAST_API_KEY, ...(await usage(env))});
}

export async function onRequestPost({request, env}) {
  if (!allowed(request, env)) return json({error: 'login required'}, 401);
  if (!env.RENTCAST_API_KEY) return json({error: 'RENTCAST_API_KEY is not set in Cloudflare'}, 500);
  const b = await request.json().catch(() => ({}));
  if (!b.key || !b.address) return json({error: 'missing property'}, 400);
  if (env.LEADS && !b.force) {
    const hit = await env.LEADS.get('rc:' + b.key, 'json');
    if (hit && Date.now() - Date.parse(hit.fetched) < 180 * 864e5) return json({result: {...hit, cached: true}, ...(await usage(env))});
  }
  const u = await usage(env);
  if (u.used + 2 > u.cap) return json({error: `This month's RentCast limit is used up (${u.used} of ${u.cap}). It resets on the 1st.`}, 429);
  const params = new URLSearchParams({address: b.address, compCount: '10'});
  if (b.propertyType) params.set('propertyType', b.propertyType);
  const hdr = {'X-Api-Key': env.RENTCAST_API_KEY, Accept: 'application/json'};
  const [vr, rr] = await Promise.all([fetch(`${API}/avm/value?${params}`, {headers: hdr}), fetch(`${API}/avm/rent/long-term?${params}`, {headers: hdr})]);
  if (env.LEADS) await env.LEADS.put('rccount:' + month(), String(u.used + 2), {expirationTtl: 70 * 864e5});
  const v = vr.ok ? await vr.json() : null, t = rr.ok ? await rr.json() : null;
  if (!v && !t) return json({error: `RentCast returned ${vr.status}: ${(await vr.text()).slice(0, 200)}`}, 502);
  const result = {fetched: new Date().toISOString(), address: b.address,
    value: v ? {price: v.price, low: v.priceRangeLow, high: v.priceRangeHigh, subject: pick(v.subjectProperty), comps: (v.comparables || []).slice(0, 10).map(comp)} : null,
    rent: t ? {rent: t.rent, low: t.rentRangeLow, high: t.rentRangeHigh, subject: pick(t.subjectProperty)} : null};
  if (env.LEADS) await env.LEADS.put('rc:' + b.key, JSON.stringify(result));
  return json({result, used: u.used + 2, cap: u.cap});
}
