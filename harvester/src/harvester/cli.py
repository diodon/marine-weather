"""harvest — build the dashboard's static data files.

    uv run --project harvester harvest --out web/public/data \
        --previous-url https://<user>.github.io/<repo>/data

Writes <out>/<source id>.json per source plus <out>/manifest.json.

The published site doubles as the harvester's state: each run fetches the
previously published file for every source (from --previous-url, else
whatever already sits in --out) and
  - merges it with fresh BOM observations, since the BOM feed only covers
    ~72 h but the dashboard keeps `window_days`;
  - falls back to it, marked status "fallback", when a source fails this
    run — one flaky upstream never blanks a panel.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests
import yaml

from . import aodn, bom, tides

log = logging.getLogger("harvest")

ATTRIBUTION = {
    "aodn_parquet": "IMOS / AODN — CC BY 4.0",
    "bom_obs": "© Commonwealth of Australia, Bureau of Meteorology",
}
QC_DROP = {4, 9}       # fail/bad, missing
QC_QUESTIONABLE = {3}


# ---------------------------------------------------------------------------
# Previous output
# ---------------------------------------------------------------------------

def load_previous(source_id: str, out_dir: Path, previous_url: str | None) -> dict | None:
    if previous_url:
        url = f"{previous_url.rstrip('/')}/{source_id}.json"
        try:
            resp = requests.get(url, timeout=30)
            if resp.ok:
                return resp.json()
            log.info("no previous %s at %s (HTTP %s)", source_id, url, resp.status_code)
        except (requests.RequestException, ValueError) as exc:
            log.warning("could not fetch previous %s: %s", source_id, exc)
    local = out_dir / f"{source_id}.json"
    if local.exists():
        return json.loads(local.read_text())
    return None


def previous_frame(prev: dict) -> tuple[pd.DataFrame, dict[str, set[int]]]:
    """Back to a frame (values only) plus questionable timestamps per variable."""
    index = pd.to_datetime(prev["time"], unit="s", utc=True)
    data = {k: v["values"] for k, v in prev["variables"].items()}
    questionable = {
        k: {prev["time"][i] for i in v.get("questionable", [])} for k, v in prev["variables"].items()
    }
    return pd.DataFrame(data, index=index), questionable


# ---------------------------------------------------------------------------
# QC
# ---------------------------------------------------------------------------

def apply_qc(df: pd.DataFrame, source: dict) -> tuple[pd.DataFrame, dict[str, pd.Series]]:
    """Null out failed/missing values; return the questionable mask per variable."""
    qc = source.get("qc", {})
    out = pd.DataFrame(index=df.index)
    questionable: dict[str, pd.Series] = {}
    for var in source["variables"]:
        if var not in df:
            continue
        values = pd.to_numeric(df[var], errors="coerce")
        flag_col = (
            f"{var}_quality_control" if qc.get("mode") == "per_variable"
            else qc.get("column") if qc.get("mode") == "single"
            else None
        )
        if flag_col and flag_col in df:
            flags = pd.to_numeric(df[flag_col], errors="coerce")
            values = values.mask(flags.isin(QC_DROP))
            questionable[var] = flags.isin(QC_QUESTIONABLE) & values.notna()
        out[var] = values
    return out, questionable


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def _clean(v, digits: int):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(float(v), digits)


def build_payload(source: dict, df: pd.DataFrame, questionable: dict[str, pd.Series],
                  lat: float, lon: float, status: str, warnings: list[str], now: datetime) -> dict:
    df = df.dropna(how="all")
    epochs = [int(t.timestamp()) for t in df.index]
    variables = {}
    for var, meta in source["variables"].items():
        if var not in df or df[var].isna().all():
            continue  # declared but not (yet) reported — e.g. FLUSI at Derwent
        digits = int(meta.get("digits", 2)) + 1  # one extra place for the charts
        entry = {k: v for k, v in meta.items()}
        entry["values"] = [_clean(v, digits) for v in df[var].tolist()]
        mask = questionable.get(var)
        if mask is not None:
            idx = [i for i, q in enumerate(mask.reindex(df.index, fill_value=False).tolist()) if q]
            if idx:
                entry["questionable"] = idx
        variables[var] = entry

    latest = df.index.max() if len(df) else None
    return {
        "id": source["id"],
        "name": source["name"],
        "kind": source["kind"],
        "description": source.get("description", ""),
        "color": source.get("color", 1),
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "link": source.get("link"),
        "attribution": ATTRIBUTION.get(source["kind"], ""),
        "collection": source.get("collection"),
        "stale_after_hours": source.get("stale_after_hours", 3),
        "generated_at": now.isoformat(timespec="seconds"),
        "latest_time": latest.isoformat() if latest is not None else None,
        "status": status,
        "warnings": warnings,
        "time": epochs,
        "variables": variables,
    }


# ---------------------------------------------------------------------------
# Per-source harvest
# ---------------------------------------------------------------------------

def harvest_source(source: dict, start: pd.Timestamp, prev: dict | None, now: datetime) -> dict:
    kind = source["kind"]
    if kind == "aodn_parquet":
        raw, warnings = aodn.read_window(source, start)
        df, questionable = apply_qc(raw, source)
        pos = raw[["LATITUDE", "LONGITUDE"]].dropna()
        lat, lon = (pos.iloc[-1]["LATITUDE"], pos.iloc[-1]["LONGITUDE"]) if len(pos) else (
            source.get("lat", math.nan), source.get("lon", math.nan))
    elif kind == "bom_obs":
        (df, lat, lon), questionable, warnings = bom.read_station(source), {}, []
        if prev:
            old, old_q = previous_frame(prev)
            df = pd.concat([old[~old.index.isin(df.index)], df]).sort_index()
            questionable = {
                k: pd.Series([int(t.timestamp()) in v for t in df.index], index=df.index)
                for k, v in old_q.items() if v
            }
    else:
        raise ValueError(f"unknown source kind {kind!r}")

    df = df[df.index >= start]
    return build_payload(source, df, questionable, float(lat), float(lon), "ok", warnings, now)


def harvest_tide(config: dict, out_dir: Path, previous_url: str | None, now: datetime) -> str | None:
    """Write tide.json, falling back to the last good file; return its name if there is one."""
    prev = load_previous("tide", out_dir, previous_url)
    try:
        payload = tides.read_tide(config["tide"], now)
        log.info("tide: %d hours, %d highs/lows", len(payload["time"]), len(payload["extremes"]))
    except Exception as exc:  # noqa: BLE001 — any upstream failure falls back
        log.error("tide failed: %s: %s", type(exc).__name__, exc)
        if prev is None:
            return None
        payload = prev | {"status": "fallback", "warnings": [f"{type(exc).__name__}: {exc}"]}
    (out_dir / "tide.json").write_text(json.dumps(payload, separators=(",", ":")))
    return "tide.json"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=Path(__file__).resolve().parents[2] / "sources.yaml")
    ap.add_argument("--out", type=Path, default=Path("web/public/data"))
    ap.add_argument("--previous-url", default=None,
                    help="Base URL of the currently published data/ directory (state for merge/fallback).")
    ap.add_argument("--only", nargs="*", help="Harvest only these source ids.")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    config = yaml.safe_load(args.config.read_text())
    args.out.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    start = pd.Timestamp(now) - pd.Timedelta(days=config.get("window_days", 30))

    manifest_sources = []
    failures = 0
    for source in config["sources"]:
        if args.only and source["id"] not in args.only:
            continue
        prev = load_previous(source["id"], args.out, args.previous_url)
        try:
            payload = harvest_source(source, start, prev, now)
            log.info("%s: %d records, latest %s", source["id"], len(payload["time"]), payload["latest_time"])
            for w in payload["warnings"]:
                log.warning("%s: %s", source["id"], w)
        except Exception as exc:  # noqa: BLE001 — any upstream failure falls back
            failures += 1
            log.error("%s failed: %s: %s", source["id"], type(exc).__name__, exc)
            if prev is None:
                continue
            payload = prev | {"status": "fallback", "warnings": [f"{type(exc).__name__}: {exc}"]}
        (args.out / f"{source['id']}.json").write_text(json.dumps(payload, separators=(",", ":")))
        manifest_sources.append({
            k: payload[k] for k in ("id", "name", "kind", "color", "lat", "lon", "latest_time",
                                    "status", "stale_after_hours")
        } | {"file": f"{source['id']}.json"})

    if args.only and (args.out / "manifest.json").exists():
        # Partial run: keep the other sources' manifest entries.
        done = {m["id"] for m in manifest_sources}
        old = json.loads((args.out / "manifest.json").read_text())["sources"]
        order = [s["id"] for s in config["sources"]]
        manifest_sources = sorted(
            manifest_sources + [m for m in old if m["id"] not in done],
            key=lambda m: order.index(m["id"]) if m["id"] in order else len(order),
        )

    tide_file = None
    if "tide" in config:
        if not args.only or "tide" in args.only:
            tide_file = harvest_tide(config, args.out, args.previous_url, now)
        elif (args.out / "tide.json").exists():
            tide_file = "tide.json"

    manifest = {
        "title": config.get("title", "Marine weather"),
        "center": config["center"],
        "window_days": config.get("window_days", 30),
        "generated_at": now.isoformat(timespec="seconds"),
        "tide": tide_file,
        "sources": manifest_sources,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    log.info("wrote %d sources to %s (%d failed)", len(manifest_sources), args.out, failures)
    # Exit non-zero only if nothing at all could be published.
    return 1 if not manifest_sources else 0


if __name__ == "__main__":
    sys.exit(main())
