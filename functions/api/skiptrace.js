// Cloudflare Pages Function: on-demand skip tracing through BatchData.
// The API key lives in the Cloudflare secret BATCHDATA_API_KEY, never in the page.
// Optional KV binding LEADS: remembers owners already traced (so nobody is paid for twice)
// and enforces the monthly cap in SKIP_MONTHLY_CAP (default 150 lookups).

const API = 'https://api.batchdata.com/api/v1/property/skip-trace';
const MAX_PER_REQUEST = 50;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
const month = () => new Date().toISOString().slice(0, 7);

function allowed(request, env) {
  // Cloudflare Access adds this header after you log in; refuse anything that didn't come through the login.
  if (env.ALLOW_WITHOUT_ACCESS === 'yes') return true;
  return !!request.headers.get('cf-access-authenticated-user-email');
}

async function usage(env) {
  if (!env.LEADS) return {used: 0, cap: +(env.SKIP_MONTHLY_CAP || 150), tracked: false};
  const used = +(await env.LEADS.get('skipcount:' + month())) || 0;
  return {used, cap: +(env.SKIP_MONTHLY_CAP || 150), tracked: true};
}

// Pull phones and emails out of one person record, whatever the exact field names.
function extract(person) {
  const phones = [], emails = new Set(), seen = new Set();
  const walk = (v, ctx) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, ctx));
    if (v && typeof v === 'object') {
      const num = v.number || v.phoneNumber || v.phone;
      if (typeof num === 'string' || typeof num === 'number') {
        const d = String(num).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
        if (d.length === 10 && !seen.has(d)) {
          seen.add(d);
          const t = String(v.type || v.phoneType || v.lineType || '').toLowerCase();
          phones.push({n: d, type: /mobile|wireless|cell/.test(t) ? 'mobile' : /land/.test(t) ? 'landline' : /voip/.test(t) ? 'VoIP' : '',
            dnc: !!(v.dnc || v.doNotCall || v.onDnc), tcpa: !!(v.tcpa || v.litigator), score: v.score ?? null});
        }
      }
      if (typeof v.email === 'string' && /@/.test(v.email)) emails.add(v.email.toLowerCase());
      Object.values(v).forEach((x) => walk(x, ctx));
    } else if (typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) emails.add(v.toLowerCase());
  };
  walk(person);
  phones.sort((a, b) => (a.dnc - b.dnc) || ((b.type === 'mobile') - (a.type === 'mobile')) || ((b.score || 0) - (a.score || 0)));
  return {phones: phones.slice(0, 8), emails: [...emails].slice(0, 5)};
}

export async function onRequestGet({request, env}) {
  if (!allowed(request, env)) return json({error: 'login required'}, 401);
  return json({configured: !!env.BATCHDATA_API_KEY, ...(await usage(env))});
}

export async function onRequestPost({request, env}) {
  if (!allowed(request, env)) return json({error: 'login required'}, 401);
  if (!env.BATCHDATA_API_KEY) return json({error: 'BATCHDATA_API_KEY is not set in Cloudflare'}, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({error: 'bad request'}, 400); }

  // One lookup per owner: drop duplicate owner keys and owners traced before.
  const seen = new Set(), todo = [], results = {};
  for (const o of (body.owners || [])) {
    if (!o || !o.key || seen.has(o.key) || !o.street || !o.city) continue;
    seen.add(o.key);
    if (env.LEADS && !body.force) {
      const cached = await env.LEADS.get('skip:' + o.key, 'json');
      if (cached) { results[o.key] = {...cached, cached: true}; continue; }
    }
    todo.push(o);
  }
  const u = await usage(env);
  const room = Math.max(0, Math.min(MAX_PER_REQUEST, u.cap - u.used));
  if (todo.length > room) return json({error: `That would use ${todo.length} lookups, but only ${room} are left under your monthly cap of ${u.cap}. Pick fewer owners or raise SKIP_MONTHLY_CAP in Cloudflare.`, results}, 429);
  if (!todo.length) return json({results, looked_up: 0, ...u});

  const res = await fetch(API, {
    method: 'POST',
    headers: {'Authorization': 'Bearer ' + env.BATCHDATA_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json'},
    body: JSON.stringify({requests: todo.map((o) => ({propertyAddress: {street: o.street, city: o.city, state: o.state || 'UT', zip: o.zip || ''}}))}),
  });
  const text = await res.text();
  if (!res.ok) return json({error: `BatchData returned ${res.status}: ${text.slice(0, 300)}`, results}, 502);
  let data; try { data = JSON.parse(text); } catch (e) { return json({error: 'BatchData sent an unreadable reply', results}, 502); }
  const persons = (data.results && (data.results.persons || data.results.data)) || data.persons || data.data || [];

  let matched = 0;
  for (let i = 0; i < todo.length; i++) {
    const r = extract(persons[i] || {});
    const out = {...r, fetched: new Date().toISOString().slice(0, 10)};
    results[todo[i].key] = out;
    if (r.phones.length || r.emails.length) matched++;
    if (env.LEADS) await env.LEADS.put('skip:' + todo[i].key, JSON.stringify(out));
  }
  if (env.LEADS) await env.LEADS.put('skipcount:' + month(), String(u.used + todo.length), {expirationTtl: 60 * 60 * 24 * 70});
  return json({results, looked_up: todo.length, matched, used: u.used + todo.length, cap: u.cap});
}
