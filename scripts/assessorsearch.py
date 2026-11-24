#!/usr/bin/env python3
"""Pull loan, equity and ownership data from the AssessorSearch API for the
Cache County leads. Runs in GitHub Actions with the key in the
ASSESSORSEARCH_API_KEY secret, and saves results to data/assessor.json,
which the app loads.

Credits (AssessorSearch pricing): lookup 1, core record 1, mortgages 3 when
rows return. Mortgages are only requested when the core record shows a loan
balance, so a free-and-clear property costs 2 credits and a mortgaged one 5.
A per-run credit cap keeps the bill predictable.
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(__file__))
from rentcast import county_parcels, prop_type, full_address  # reuse the county pull

KEY = os.environ.get("ASSESSORSEARCH_API_KEY", "").strip()
BASES = [b for b in [os.environ.get("ASSESSORSEARCH_BASE_URL", "").strip().rstrip("/"),
                     "https://api.assessorsearch.com", "https://assessorsearch.com/api"] if b]
FIPS = "49005"  # Cache County, Utah
CREDIT_CAP = int(os.environ.get("CREDIT_CAP") or 480)   # API Starter includes 500/month
STALE_DAYS = 120
ONLY = [p.strip() for p in (os.environ.get("PARCELS") or "").replace(";", ",").split(",") if p.strip()]
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "assessor.json")
AUTHS = [lambda k: {"Authorization": "Bearer " + k}, lambda k: {"X-API-Key": k}, lambda k: {"x-api-key": k, "Authorization": "Bearer " + k}]
conn = {"base": None, "auth": None}


def call(path, params=None):
    """GET with whichever base URL and auth style the API accepts (found on the first call)."""
    combos = [(conn["base"], conn["auth"])] if conn["base"] else [(b, a) for b in BASES for a in AUTHS]
    last = None
    for base, auth in combos:
        url = base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        req = urllib.request.Request(url, headers=dict(auth(KEY), Accept="application/json"))
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read().decode()
                conn["base"], conn["auth"] = base, auth
                return json.loads(body) if body.strip() else None
        except urllib.error.HTTPError as e:
            if e.code == 404 and conn["base"]:
                return None  # no match: no charge
            last = f"{e.code} {e.reason} at {base}{path}: {e.read()[:300].decode(errors='replace')}"
            if conn["base"]:
                raise RuntimeError(last)
        except urllib.error.URLError as e:
            last = f"{e.reason} at {base}"
    raise RuntimeError("Could not connect to the AssessorSearch API. Last error: " + str(last) +
                       "\nIf their docs list a different base URL, add it as a repository variable named ASSESSORSEARCH_BASE_URL.")


def rows_of(j):
    if j is None: return []
    if isinstance(j, list): return j
    for k in ("data", "results", "properties", "items", "rows", "mortgages", "transactions"):
        if isinstance(j.get(k), list): return j[k]
    return [j] if isinstance(j, dict) and j.get("property_id") else []


def record_of(j):
    if isinstance(j, dict) and isinstance(j.get("data"), dict): return j["data"]
    return j if isinstance(j, dict) else {}


KEEP = ("property_id", "property_address", "owner_1_full_name", "owner_2_full_name", "mailing_full_address", "occupancy", "ownership_date",
        "owner_since", "estimated_market_value", "total_market_value", "last_sale_date", "last_sale_amount", "combined_estimated_loan_balance",
        "estimated_equity", "estimated_ltv", "bedrooms", "bathrooms", "living_area", "year_built", "foreclosure_status", "listing_status")
MKEEP = ("amount", "lender", "interest_rate", "recording_date", "type", "payment", "term", "position")


def main():
    if not KEY:
        print("ASSESSORSEARCH_API_KEY secret is not set. Add it under Settings > Secrets and variables > Actions."); sys.exit(1)
    data = {"updated": None, "parcels": {}}
    if os.path.exists(OUT):
        with open(OUT) as fh: data = json.load(fh)
    have, now = data.get("parcels") or {}, datetime.now(timezone.utc)

    def fresh(t):
        p = have.get(t)
        return p and p.get("fetched") and now - datetime.fromisoformat(p["fetched"]) < timedelta(days=STALE_DAYS)

    parcels = county_parcels()
    if ONLY:
        cands = [r for r in parcels if r["tax_id"] in ONLY]
    else:
        cands = [r for r in parcels if (prop_type(r["type"]) or r["type"]) and not fresh(r["tax_id"])]
        cands.sort(key=lambda r: (prop_type(r["type"]) is None, -r["years"], -r["due"]))   # homes first, most behind first
    print(f"{len(cands)} parcels to look up; credit cap this run: {CREDIT_CAP}")

    used = done = 0
    for r in cands:
        if used + 5 > CREDIT_CAP:
            print("Credit cap reached; stopping. Run again next month or raise CREDIT_CAP."); break
        tid = r["tax_id"]
        try:
            hits = rows_of(call("/v1/properties", {"apn": tid, "fips": FIPS}))
            if not hits:
                hits = rows_of(call("/v1/properties", {"apn": tid.replace("-", ""), "fips": FIPS}))
            if not hits and full_address(r):
                street, city, _ = full_address(r).split(", ")
                hits = rows_of(call("/v1/properties", {"address": street, "city": city, "state": "UT"}))
            if not hits:
                print(f"{tid}: no match"); continue
            used += 1
            pid = hits[0].get("property_id") or hits[0].get("id")
            core = hits[0] if "combined_estimated_loan_balance" in hits[0] else record_of(call(f"/v1/properties/{pid}"))
            if core is not hits[0]: used += 1
            rec = {"fetched": now.isoformat(timespec="seconds"), **{k: core.get(k) for k in KEEP if core.get(k) is not None}}
            if (core.get("combined_estimated_loan_balance") or 0) > 0:
                ms = rows_of(call(f"/v1/properties/{pid}/mortgages"))
                if ms: used += 3
                rec["mortgages"] = [{k: m.get(k) for k in MKEEP if m.get(k) is not None} for m in ms]
            have[tid] = rec; done += 1
            print(f"{tid}: value {rec.get('estimated_market_value')}, loans {rec.get('combined_estimated_loan_balance')}, owner {rec.get('owner_1_full_name')}")
        except RuntimeError as e:
            print(str(e)); break
        time.sleep(0.3)

    data.update({"updated": now.isoformat(timespec="seconds"), "parcels": have, "last_run": {"looked_up": done, "credits_est": used}})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh: json.dump(data, fh, indent=1, sort_keys=True)
    print(f"Done: {done} properties, about {used} credits used.")
    if done == 0 and cands: sys.exit(1)


if __name__ == "__main__":
    main()
