# Derwent Estuary · Blackmans Bay — marine weather dashboard

A static dashboard on GitHub Pages showing current values and recent history for:

| Source | What | Feed |
|---|---|---|
| **Derwent River B1** (IMOS estuarine & coastal mooring) | water temperature, salinity, O₂ saturation, chlorophyll-a, turbidity, fDOM, phycoerythrin, FLUSI | AODN cloud-optimised Parquet `mooring_estuarine_coastal_water_quality_monitoring_realtime_qc`, `site_code=TAS-DERWENT-RIVER-B1` |
| **Storm Bay wave buoy** | significant wave height, peak and mean period, directions, spread | AODN cloud-optimised Parquet `wave_buoy_realtime_nonqc`, `site_name=STORM-BAY` |
| **Dennes Point** (BOM AWS 094255, ~7 km from Blackmans Bay) | wind, gust, direction, air temperature, humidity, pressure, rain | BOM anonymous FTP `IDT60920.xml` |
| **Tide** (modelled, ~8 km grid) | sea level, next high and low tides, 7-day table | Open-Meteo Marine API `sea_level_height_msl` |
| **Sunrise, sunset** | calculated in the browser for the map centre | SunCalc |

```
GitHub Actions (hourly)
  harvester/  ── reads s3://aodn-cloud-optimised (anonymous) + ftp.bom.gov.au
     │          merges with the currently published data/*.json
     ▼
  web/public/data/*.json  ──  vite build  ──  GitHub Pages
                                              web/ (MapLibre + uPlot)
```

## Why a harvester, not direct browser reads

The `aodn-cloud-optimised` bucket sends no CORS headers, so a browser can't
range-read the Parquet/Zarr itself. The harvester pulls only what the
dashboard needs: the last `window_days` from the site's newest `timestamp=`
partitions, pruned by footer row-group statistics. It writes small JSON files
that the static site loads.

## Data handling

- **QC.** IMOS flags 4 (fail/bad) and 9 (missing) are dropped. Flag 3
  (questionable) is kept but marked, and is hidden in the dashboard unless
  "Include questionable data" is ticked. The wave buoy feed is real-time and
  non-QC'd, with a single `WAVE_quality_control` flag for all its variables.
- **BOM history.** The FTP product only carries the latest observation, so
  history builds up one reading per run (up to `window_days`). The charts
  start sparse after the first deploy.
- **Resilience.** If an upstream fails, the last published file for that
  source is kept and flagged as "Upstream error". Sources whose newest
  reading is older than `stale_after_hours` are flagged "Stale".
- **Tide.** BOM's FTP has no tide predictions, so heights come from Open-Meteo's
  hourly ocean model (free for non-commercial use, CC BY 4.0). They are relative
  to mean sea level rather than chart datum, include weather effects, and high/low
  times are interpolated from hourly values. Treat them as a guide, not official
  predictions. Each run fetches 7 days ahead, so the card keeps working through
  upstream failures.
- Variables declared in `sources.yaml` that a source doesn't currently report
  (e.g. FLUSI at Derwent B1) are skipped until they appear.

## Configure

Everything about sources lives in [`harvester/sources.yaml`](harvester/sources.yaml):
the map centre, the history window, and per source its variables, labels,
units, decimals, which charts show by default, and its colour slot. To add
Hobart (Ellerslie Road) as a second BOM station, copy the Dennes Point block
with `wmo: 94970` and `color: 4`. The dashboard's palette defines slots 1–3,
so add a validated `--series-4` in `web/src/style.css` as well.

## Run locally

```bash
uv run --project harvester harvest --out web/public/data   # ~30 s
cd web && npm install && npm run dev                       # http://localhost:5173
```

Re-running `harvest` merges with the existing local files, the same way CI
does with the published ones. `--only <id>` harvests a single source.

## Deploy

1. Create the public repository and push `main`.
2. Settings → Pages → Source: **GitHub Actions**.
3. Run the **Harvest & deploy** workflow once from the Actions tab. After
   that it runs on push and hourly.

GitHub disables scheduled workflows in public repositories after 60 days
without repository activity. Re-enable the workflow from the Actions tab if
that happens.

## Attribution

IMOS data are provided by the Australian Ocean Data Network under CC BY 4.0.
IMOS is enabled by the National Collaborative Research Infrastructure
Strategy (NCRIS). Weather observations © Commonwealth of Australia, Bureau of
Meteorology. Basemap © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap.
Real-time data are provisional. Not for navigation.

## Licence

- **Code:** [MIT](LICENSE).
- **Content** (the dashboard's original text and other non-code material):
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **Data** are not covered by either licence and remain under their providers'
  licences: IMOS / AODN (CC BY 4.0), Bureau of Meteorology (© Commonwealth of
  Australia) and Open-Meteo / Copernicus Marine (CC BY 4.0).
