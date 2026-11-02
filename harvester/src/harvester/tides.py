"""High and low tides from BOM's official predictions for Hobart.

BOM's anonymous FTP carries no tide predictions, so `data/bom_tides_hobart.json` is
built from its annual PDF tables by `scripts/parse_bom_tides.py`. Heights are above
Lowest Astronomical Tide and exclude weather effects. The curve between tides is our
own cosine interpolation, not a BOM product.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path

TABLE = Path(__file__).parent / "data" / "bom_tides_hobart.json"
STEP = 600  # seconds between points on the curve
DAY = 86400


def curve(tides: list[list]) -> tuple[list[int], list[float]]:
    """Heights between consecutive tides, following half a cosine from one to the next."""
    times: list[int] = []
    heights: list[float] = []
    for (t0, h0, _), (t1, h1, _) in zip(tides, tides[1:]):
        # Whole steps from t0, so the curve passes through each tide exactly.
        for t in range(t0, t1, STEP):
            f = (1 - math.cos(math.pi * (t - t0) / (t1 - t0))) / 2
            times.append(t)
            heights.append(round(h0 + f * (h1 - h0), 3))
    times.append(tides[-1][0])
    heights.append(tides[-1][1])
    return times, heights


def read_tide(source: dict, now: datetime) -> dict:
    table = json.loads(TABLE.read_text())
    start = now.timestamp() - DAY
    end = now.timestamp() + source.get("forecast_days", 8) * DAY
    # One tide beyond each end, so the curve covers the whole window.
    rows = table["tides"]
    first = max((i for i, r in enumerate(rows) if r[0] <= start), default=0)
    last = min((i for i, r in enumerate(rows) if r[0] >= end), default=len(rows) - 1)
    tides = rows[first:last + 1]
    if len(tides) < 2 or tides[-1][0] <= now.timestamp():
        raise RuntimeError("BOM tide table has run out; add the next year's table")
    times, heights = curve(tides)
    return {
        "lat": table["lat"],
        "lon": table["lon"],
        "generated_at": now.isoformat(timespec="seconds"),
        "status": "ok",
        "warnings": [],
        "time": times,
        "height": heights,
        "extremes": [{"time": t, "height": h, "type": kind} for t, h, kind in tides],
    }
