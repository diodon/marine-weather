"""Modelled sea level and high/low tides from the Open-Meteo Marine API.

BOM's anonymous FTP carries no tide predictions, so this uses Open-Meteo's
`sea_level_height_msl` (Copernicus Marine, ~8 km grid, hourly, relative to mean
sea level — not chart datum). It also includes non-tidal effects such as the
inverted barometer, so treat it as a guide rather than official predictions.
"""

from __future__ import annotations

from datetime import datetime

import requests

API = "https://marine-api.open-meteo.com/v1/marine"
MIN_RANGE_M = 0.05  # high/low pairs closer than this are model wobble, not tides


def _peak(times: list[int], heights: list[float], i: int) -> tuple[int, float]:
    """Refine a turning point at hourly sample i with a parabola through its neighbours."""
    a, b, c = heights[i - 1], heights[i], heights[i + 1]
    curve = a - 2 * b + c
    offset = 0.5 * (a - c) / curve if curve else 0.0
    step = times[i + 1] - times[i]
    return round(times[i] + offset * step), b - 0.25 * (a - c) * offset


def find_extremes(times: list[int], heights: list[float]) -> list[dict]:
    """High and low tides, alternating, in time order."""
    found: list[dict] = []
    samples: list[float] = []  # hourly heights behind `found`; the parabola can exaggerate small wobbles
    for i in range(1, len(heights) - 1):
        before, here, after = heights[i - 1], heights[i], heights[i + 1]
        if before < here >= after:
            kind = "high"
        elif before > here <= after:
            kind = "low"
        else:
            continue
        if samples and abs(samples[-1] - here) < MIN_RANGE_M:
            found.pop()  # the pair cancels out; what's left still alternates
            samples.pop()
            continue
        t, h = _peak(times, heights, i)
        found.append({"time": t, "height": round(h, 2), "type": kind})
        samples.append(here)
    return found


def read_tide(source: dict, now: datetime, timeout: int = 30) -> dict:
    resp = requests.get(API, timeout=timeout, params={
        "latitude": source["lat"],
        "longitude": source["lon"],
        "hourly": "sea_level_height_msl",
        "past_days": 1,
        "forecast_days": source.get("forecast_days", 7),
        "timeformat": "unixtime",
    })
    resp.raise_for_status()
    body = resp.json()
    rows = [(t, h) for t, h in zip(body["hourly"]["time"], body["hourly"]["sea_level_height_msl"])
            if h is not None]
    if len(rows) < 3:
        raise RuntimeError("no sea level values for this location")
    times, heights = [t for t, _ in rows], [h for _, h in rows]
    return {
        "lat": body["latitude"],   # the model grid cell actually used
        "lon": body["longitude"],
        "generated_at": now.isoformat(timespec="seconds"),
        "status": "ok",
        "warnings": [],
        "time": times,
        "height": heights,
        "extremes": find_extremes(times, heights),
    }
