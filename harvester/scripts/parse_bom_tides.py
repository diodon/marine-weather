#!/usr/bin/env python3
"""Turn BOM's annual tide table PDFs into the JSON the harvester publishes from.

Usage: parse_bom_tides.py OUT.json TABLE.pdf [TABLE.pdf ...]
Needs `pdftotext` (poppler). Run by hand once a year, when BOM's next table is out.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Australia/Hobart")  # tables are in local time, daylight saving included
MONTHS = "JANUARY FEBRUARY MARCH APRIL MAY JUNE JULY AUGUST SEPTEMBER OCTOBER NOVEMBER DECEMBER".split()
WORD = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>')
SAME_ROW = 2.0  # points


def page_words(pdf: Path) -> list[list[tuple[float, float, float, str]]]:
    xml = subprocess.run(["pdftotext", "-bbox", str(pdf), "-"], check=True, capture_output=True, text=True).stdout
    return [
        [(float(x0), float(y0), float(x1), text) for x0, y0, x1, _, text in WORD.findall(page)]
        for page in xml.split("<page ")[1:]
    ]


def parse_page(words: list[tuple[float, float, float, str]], year: int) -> list[tuple[datetime, float]]:
    """A page holds four months, each split into two columns of day cells."""
    months = [MONTHS.index(w[3]) + 1 for w in sorted((w for w in words if w[3] in MONTHS), key=lambda w: w[0])]
    columns = sorted(w[0] for w in words if w[3] == "Time" and w[1] > 95)
    if len(months) != 4 or len(columns) != 8:
        raise ValueError(f"expected 4 months and 8 columns, found {months} and {len(columns)}")

    def column_of_entry(x: float) -> int:
        return min(range(8), key=lambda i: abs(columns[i] - x))

    def column_of_day(x: float) -> int:
        return next(i for i in range(8) if x < columns[i])

    body = [w for w in words if w[1] > 108]
    times = [w for w in body if re.fullmatch(r"\d{4}", w[3])]
    heights = [w for w in body if re.fullmatch(r"-?\d\.\d\d", w[3])]
    days = [w for w in body if re.fullmatch(r"\d{1,2}", w[3])]
    if len(times) != len(heights):
        raise ValueError(f"{len(times)} times but {len(heights)} heights")

    out = []
    for t in times:
        same_row = [h for h in heights if abs(h[1] - t[1]) < SAME_ROW and h[0] > t[0]]
        height = min(same_row, key=lambda h: h[0])
        col = column_of_entry(t[0])
        # A day's number sits level with the first row of its cell.
        day = max((d for d in days if column_of_day(d[0]) == col and d[1] < t[1] + SAME_ROW), key=lambda d: d[1])
        out.append((
            datetime(year, months[col // 2], int(day[3]), int(t[3][:2]), int(t[3][2:]), tzinfo=TZ),
            float(height[3]),
        ))
    return out


def label(rows: list[tuple[datetime, float]]) -> list[list]:
    """The tables don't label high and low. They alternate, which also settles the few
    neap-tide pairs whose heights tie to two decimals."""
    is_high = rows[0][1] > rows[1][1]
    out = []
    for when, height in rows:
        out.append([int(when.timestamp()), height, "high" if is_high else "low"])
        is_high = not is_high
    for a, b in zip(out, out[1:]):
        if (a[1] < b[1]) if a[2] == "high" else (a[1] > b[1]):
            raise ValueError(f"heights don't alternate at {a[0]} and {b[0]}")
    return out


def main() -> None:
    out_path, *pdfs = sys.argv[1:]
    rows: list[tuple[datetime, float]] = []
    copyright_years = []
    for pdf in map(Path, pdfs):
        pages = page_words(pdf)
        tables = [p for p in pages if any(w[3] == "Waters" for w in p)]
        if len(tables) != 3:
            raise ValueError(f"{pdf}: expected 3 pages of tables, found {len(tables)}")
        year = int(re.search(r"_(\d{4})_", pdf.name).group(1))
        for page in tables:
            rows += parse_page(page, year)
        text = " ".join(w[3] for w in tables[0])
        copyright_years.append(int(re.search(r"Australia (\d{4})", text).group(1)))
    rows.sort(key=lambda r: r[0])
    if any(a[0] >= b[0] for a, b in zip(rows, rows[1:])):
        raise ValueError("duplicate times")
    Path(out_path).write_text(json.dumps({
        "station": "Hobart",
        "lat": -(42 + 52 / 60 + 38 / 3600),
        "lon": 147 + 20 / 60 + 27 / 3600,
        "datum": "Lowest Astronomical Tide",
        "copyright_years": sorted(set(copyright_years)),
        "tides": label(rows),
    }, separators=(",", ":")) + "\n")
    print(f"{len(rows)} tides, {rows[0][0]} to {rows[-1][0]}")


if __name__ == "__main__":
    main()
