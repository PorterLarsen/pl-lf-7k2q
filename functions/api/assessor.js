// Cloudflare Pages Function: on-demand AssessorSearch lookup (estimated loans, equity, ownership) for one parcel.
// Key: Cloudflare secret ASSESSORSEARCH_API_KEY. Optional variable ASSESSORSEARCH_BASE_URL.
// KV binding LEADS caches each parcel for 120 days and tracks ASSESSOR_MONTHLY_CAP credits (default 480).
const FIPS = '49005'; // Cache County, Utah
const json = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
const month = () => new Date().toISOString().slice(0, 7);
const allowed = (req, env) => env.ALLOW_WITHOUT_ACCESS === 'yes' || !!req.headers.get('cf-access-authenticated-user-email');
const KEEP = ['property_id', 'property_address', 'owner_1_full_name', 'owner_2_full_name', 'mailing_full_address', 'occupancy', 'ownership_date', 'owner_since',
  'estimated_market_value', 'total_market_value', 'last_sale_date', 'last_sale_amount', 'combined_estimated_loan_balance', 'estimated_equity', 'estimated_ltv',
  'bedrooms', 'bathrooms', 'living_area', 'year_built', 'foreclosure_status', 'listing_status'];
const MKEEP = ['amount', 'lender', 'interest_rate', 'recording_date', 'type', 'payment', 'term', 'position'];
const rowsOf = (j) => { if (!j) return []; if (Array.isArray(j)) return j; for (const k of ['data', 'results', 'properties', 'items', 'rows', 'mortgages']) if (Array.isArray(j[k])) return j[k]; return j.property_id ? [j] : []; };

function combos(env) {
  const bases = [env.ASSESSORSEARCH_BASE_URL, 'https://api.assessorsearch.com', 'https://assessorsearch.com/api'].filter(Boolean).map((b) => b.replace(/\/$/, ''));
  const auths = [(k) => ({Authorization: 'Bearer ' + k}), (k) => ({'X-API-Key': k})];
  return bases.flatMap((b) => auths.map((a) => [b, a]));
}

export async function onRequestGet({request, env}) {
  if (!allowed(request, env)) return json({error: 'login required'}, 401);
  const cap = +(env.ASSESSOR_MONTHLY_CAP || 480), used = env.LEADS ? +(await env.LEADS.get('ascount:' + month())) || 0 : 0;
  return json({configured: !!env.ASSESSORSEARCH_API_KEY, used, cap});
}

export async function onRequestPost({request, env}) {
  if (!allowed(request, env)) return json({error: 'login required'}, 401);
  const key = env.ASSESSORSEARCH_API_KEY;
  if (!key) return json({error: 'ASSESSORSEARCH_API_KEY is not set in Cloudflare'}, 500);
  const b = await request.json().catch(() => ({}));
  if (!b.apn && !b.address) return json({error: 'missing parcel'}, 400);
  const ck = 'as:' + (b.apn || b.address);
  if (env.LEADS && !b.force) {
    const hit = await env.LEADS.get(ck, 'json');
    if (hit && Date.now() - Date.parse(hit.fetched) < 120 * 864e5) return json({result: {...hit, cached: true}});
  }
  const cap = +(env.ASSESSOR_MONTHLY_CAP || 480);
  let used = env.LEADS ? +(await env.LEADS.get('ascount:' + month())) || 0 : 0;
  if (used + 5 > cap) return json({error: `This month's AssessorSearch credit cap is reached (${used} of ${cap}).`}, 429);

  let conn = null, lastErr = '';
  const call = async (path, params) => {
    const qs = params ? '?' + new URLSearchParams(params) : '';
    for (const [base, auth] of conn ? [conn] : combos(env)) {
      const res = await fetch(base + path + qs, {headers: {...auth(key), Accept: 'application/json'}});
      if (res.ok) { conn = [base, auth]; const t = await res.text(); return t.trim() ? JSON.parse(t) : null; }
      if (res.status === 404 && conn) return null;
      lastErr = `${res.status} at ${base}${path}: ${(await res.text()).slice(0, 200)}`;
      if (conn) throw new Error(lastErr);
    }
    throw new Error('Could not connect to AssessorSearch. ' + lastErr);
  };
  try {
    let hits = b.apn ? rowsOf(await call('/v1/properties', {apn: b.apn, fips: FIPS})) : [];
    if (!hits.length && b.apn) hits = rowsOf(await call('/v1/properties', {apn: b.apn.replace(/-/g, ''), fips: FIPS}));
    if (!hits.length && b.address) hits = rowsOf(await call('/v1/properties', {address: b.address, city: b.city || '', state: 'UT'}));
    if (!hits.length) return json({error: 'AssessorSearch has no record for this parcel.'}, 404);
    used += 1;
    const pid = hits[0].property_id || hits[0].id;
    let core = hits[0];
    if (!('combined_estimated_loan_balance' in core)) { const c = await call('/v1/properties/' + pid); core = (c && c.data) || c || {}; used += 1; }
    const result = {fetched: new Date().toISOString()};
    KEEP.forEach((k) => { if (core[k] != null) result[k] = core[k]; });
    if ((core.combined_estimated_loan_balance || 0) > 0) {
      const ms = rowsOf(await call(`/v1/properties/${pid}/mortgages`));
      if (ms.length) used += 3;
      result.mortgages = ms.map((m) => Object.fromEntries(MKEEP.filter((k) => m[k] != null).map((k) => [k, m[k]])));
    }
    if (env.LEADS) { await env.LEADS.put(ck, JSON.stringify(result)); await env.LEADS.put('ascount:' + month(), String(used), {expirationTtl: 70 * 864e5}); }
    return json({result, used, cap});
  } catch (e) {
    return json({error: String(e.message || e)}, 502);
  }
}
