#!/usr/bin/env python3
"""Monthly RentCast lookup for the top Cache County leads.

Runs in GitHub Actions. Reads the API key from the RENTCAST_API_KEY secret,
looks up value and rent estimates for the highest-priority delinquent homes
that don't have a recent estimate, and saves the results to data/rentcast.json
(which the app loads). Stays under a monthly call cap so the free plan is never
exceeded.
"""
import json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

BACKTAX = "https://gis.cachecounty.gov/arcgis/rest/services/Treasurer/Delinquent_Taxes_5_years_Back/MapServer/0/query"
API = "https://api.rentcast.io/v1"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "rentcast.json")

KEY = os.environ.get("RENTCAST_API_KEY", "").strip()
CAP = int(os.environ.get("MONTHLY_CAP") or 48)          # free plan = 50 calls/month
MAX_PROPS = int(os.environ.get("MAX_PROPERTIES") or 20)  # each property = 2 calls (value + rent)
STALE_DAYS = 180
ONLY = [p.strip() for p in (os.environ.get("PARCELS") or "").replace(";", ",").split(",") if p.strip()]


def get(url, params, headers=None):
    req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params), headers=headers or {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def pick(a, name):
    for k, v in a.items():
        if k == name or k.endswith("." + name):
            return v
    return None


def pick_pref(a, name, pref):
    for k, v in a.items():
        if pref in k and k.endswith("." + name):
            return v
    return pick(a, name)


def county_parcels():
    ids = get(BACKTAX, {"where": "1=1", "returnIdsOnly": "true", "f": "json"}).get("objectIds") or []
    ids.sort()
    rows = []
    for i in range(0, len(ids), 100):
        j = get(BACKTAX, {"objectIds": ",".join(map(str, ids[i:i + 100])), "outFields": "*", "returnGeometry": "false", "f": "json"})
        for f in j.get("features", []):
            a = f["attributes"]
            owed = [float(pick(a, f"back{k}_total") or 0) for k in range(1, 6)]
            rows.append({
                "tax_id": pick_pref(a, "tax_id", "parcel_current"),
                "address": (pick(a, "address_complete") or "").strip(),
                "city": (pick(a, "property_city_hs") or "").strip(),
                "type": (pick(a, "building_specific_type_hs") or "").upper(),
                "units": pick(a, "total_units"),
                "due": float(pick(a, "all_yr_total_due") or 0),
                "years": sum(1 for v in owed if v > 0),
            })
    return [r for r in rows if r["tax_id"]]


def prop_type(t):
    if "CONDO" in t: return "Condo"
    if "TWN" in t or "TOWN" in t: return "Townhouse"
    if any(x in t for x in ("DUP", "TRI", "4PLEX", "FOURPLEX", "MULTI", "APT")): return "Multi-Family"
    if "MOBILE" in t or "MH" in t or "MANUF" in t: return "Manufactured"
    if "SFR" in t or "SINGLE" in t: return "Single Family"
    return None


def full_address(r):
    street = r["address"].split(",")[0].strip().title()
    city = r["city"].title() if r["city"] and "UNINCORP" not in r["city"].upper() else (r["address"].split(",")[-1].strip().title() if "," in r["address"] else "")
    return f"{street}, {city}, UT" if street and city else ""


def slim_comp(c):
    return {"address": c.get("formattedAddress"), "price": c.get("price"), "sqft": c.get("squareFootage"), "bd": c.get("bedrooms"),
            "ba": c.get("bathrooms"), "built": c.get("yearBuilt"), "dist": c.get("distance"), "status": c.get("status"),
            "date": c.get("removedDate") or c.get("listedDate"), "type": c.get("propertyType")}


SUBJ = ("propertyType", "bedrooms", "bathrooms", "squareFootage", "lotSize", "yearBuilt", "lastSaleDate", "lastSalePrice")


def main():
    if not KEY:
        print("RENTCAST_API_KEY secret is not set. Add it under Settings > Secrets and variables > Actions.")
        sys.exit(1)
    data = {"updated": None, "usage": {}, "parcels": {}}
    if os.path.exists(OUT):
        with open(OUT) as fh:
            data = json.load(fh)
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    usage = data.get("usage") or {}
    if usage.get("month") != month:
        usage = {"month": month, "calls": 0}
    left = CAP - usage["calls"]
    print(f"Calls used this month: {usage['calls']} of {CAP}")

    parcels = county_parcels()
    print(f"County parcels behind on taxes: {len(parcels)}")
    now = datetime.now(timezone.utc)
    have = data.get("parcels") or {}

    def fresh(tid):
        p = have.get(tid)
        return p and p.get("fetched") and now - datetime.fromisoformat(p["fetched"]) < timedelta(days=STALE_DAYS)

    if ONLY:
        cands = [r for r in parcels if r["tax_id"] in ONLY]
        missing = set(ONLY) - {r["tax_id"] for r in cands}
        if missing:
            print("Not on the delinquent list (skipped):", ", ".join(sorted(missing)))
    else:
        cands = [r for r in parcels if prop_type(r["type"]) and full_address(r) and not fresh(r["tax_id"])]
        cands.sort(key=lambda r: (-r["years"], -r["due"]))
    cands = cands[:MAX_PROPS]

    hdr = {"X-Api-Key": KEY, "Accept": "application/json"}
    done = 0
    for r in cands:
        if left < 2:
            print("Monthly cap reached; stopping.")
            break
        addr = full_address(r)
        if not addr:
            continue
        params = {"address": addr, "compCount": 10}
        pt = prop_type(r["type"])
        if pt:
            params["propertyType"] = pt
        rec = {"fetched": now.isoformat(timespec="seconds"), "address": addr}
        try:
            v = get(API + "/avm/value", params, hdr); left -= 1; usage["calls"] += 1
            rec["value"] = {"price": v.get("price"), "low": v.get("priceRangeLow"), "high": v.get("priceRangeHigh"),
                            "subject": {k: (v.get("subjectProperty") or {}).get(k) for k in SUBJ},
                            "comps": [slim_comp(c) for c in (v.get("comparables") or [])[:10]]}
        except Exception as e:
            print(f"{r['tax_id']} value lookup failed: {e}"); left -= 1; usage["calls"] += 1
        try:
            t = get(API + "/avm/rent/long-term", params, hdr); left -= 1; usage["calls"] += 1
            rec["rent"] = {"rent": t.get("rent"), "low": t.get("rentRangeLow"), "high": t.get("rentRangeHigh"),
                           "subject": {k: (t.get("subjectProperty") or {}).get(k) for k in SUBJ}}
        except Exception as e:
            print(f"{r['tax_id']} rent lookup failed: {e}"); left -= 1; usage["calls"] += 1
        if rec.get("value") or rec.get("rent"):
            have[r["tax_id"]] = rec; done += 1
            print(f"{r['tax_id']} {addr}: value {rec.get('value', {}).get('price')}, rent {rec.get('rent', {}).get('rent')}")
        time.sleep(0.5)

    data.update({"updated": now.isoformat(timespec="seconds"), "usage": usage, "parcels": have})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(data, fh, indent=1, sort_keys=True)
    print(f"Looked up {done} properties. Calls used this month: {usage['calls']} of {CAP}.")


if __name__ == "__main__":
    main()
