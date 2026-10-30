"""Latest observation for one BOM station, from the Bureau's anonymous FTP
product feed (ftp://ftp.bom.gov.au/anon/gen/fwo/) — the channel BOM
provides for automated access.

IDT60920.xml carries the latest reading of every Tasmanian AWS (updated
~every 10 min), so each harvest contributes one record per station;
history is built by merging with the previously published file (cli.py).
"""

from __future__ import annotations

import urllib.request
import xml.etree.ElementTree as ET

import pandas as pd

FEED = "ftp://ftp.bom.gov.au/anon/gen/fwo/{product}.xml"


def _number(text: str | None) -> float | None:
    if text is None or text.strip() in ("", "-"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def read_station(source: dict, timeout: int = 60) -> tuple[pd.DataFrame, float, float]:
    """Return (one-row frame indexed by UTC time, lat, lon)."""
    url = FEED.format(product=source["product"])
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        root = ET.fromstring(resp.read())

    wmo = str(source["wmo"])
    station = next((s for s in root.iter("station") if s.get("wmo-id") == wmo), None)
    if station is None:
        raise RuntimeError(f"station wmo {wmo} not in {url}")
    period = station.find("period")
    if period is None:
        raise RuntimeError(f"station wmo {wmo} has no current observation in {url}")

    elements = {e.get("type"): e.text for e in period.iter("element")}
    rec = {"TIME": pd.Timestamp(period.get("time-utc")).tz_convert("UTC")}
    rec |= {var: _number(elements.get(var)) for var in source["variables"]}
    df = pd.DataFrame.from_records([rec]).set_index("TIME")
    return df, float(station.get("lat")), float(station.get("lon"))
