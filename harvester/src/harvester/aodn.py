"""Read a recent time window of one site from an AODN cloud-optimised Parquet
collection (s3://aodn-cloud-optimised, anonymous).

Layout is Hive-partitioned, e.g.
    <co>.parquet/site_code=X/timestamp=<epoch>/polygon=<wkb hex>/<file>.parquet
The span of a timestamp= partition differs per collection (yearly for the
estuarine moorings, monthly for wave buoys), so partitions are chosen by
"could this one overlap the window": its own epoch, up to the next one's.

Lessons carried over from the QCtests suite (DataUplift/Pipelines/QCtests):
- resolve columns by name per file — physical column order differs between
  files of one collection;
- a file in the newest partition can fail to open while the pipeline is
  rewriting it — skip it rather than failing the whole source;
- filter on footer row-group statistics before reading any rows.
"""

from __future__ import annotations

import logging
import re

import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from pyarrow import fs as pafs

BUCKET = "aodn-cloud-optimised"
REGION = "ap-southeast-2"
TIME_COL = "TIME"

_TS_RE = re.compile(r"timestamp=(-?\d+)$")

log = logging.getLogger(__name__)


def _s3() -> pafs.S3FileSystem:
    return pafs.S3FileSystem(anonymous=True, region=REGION)


def _list_dirs(s3: pafs.S3FileSystem, path: str) -> list[str]:
    infos = s3.get_file_info(pafs.FileSelector(path, recursive=False))
    return [i.path for i in infos if i.type == pafs.FileType.Directory]


def _list_parquet(s3: pafs.S3FileSystem, path: str) -> list[str]:
    infos = s3.get_file_info(pafs.FileSelector(path, recursive=True))
    return [i.path for i in infos if i.type == pafs.FileType.File and i.path.endswith(".parquet")]


def _candidate_partitions(s3: pafs.S3FileSystem, site_dir: str, start: pd.Timestamp) -> list[str]:
    """timestamp= partitions that can hold data at or after `start`."""
    parts = []
    for d in _list_dirs(s3, site_dir):
        m = _TS_RE.search(d.rstrip("/"))
        if m:
            parts.append((int(m.group(1)), d))
    parts.sort()
    start_epoch = start.timestamp()
    keep = []
    for i, (_, d) in enumerate(parts):
        next_epoch = parts[i + 1][0] if i + 1 < len(parts) else float("inf")
        if next_epoch > start_epoch:
            keep.append(d)
    return keep


def _file_max_time(meta: pq.FileMetaData, time_idx: int) -> pd.Timestamp | None:
    best = None
    for rg in range(meta.num_row_groups):
        stats = meta.row_group(rg).column(time_idx).statistics
        if stats is None or not stats.has_min_max:
            return None  # no stats somewhere: can't prune this file safely
        v = pd.Timestamp(stats.max)
        best = v if best is None or v > best else best
    return best


def _to_utc(ts: pd.Timestamp) -> pd.Timestamp:
    return ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")


def read_window(source: dict, start: pd.Timestamp) -> tuple[pd.DataFrame, list[str]]:
    """Return (frame indexed by UTC time, warnings). Columns are the source's
    variables plus whichever QC columns the source's qc mode needs."""
    s3 = _s3()
    part = source["partition"]
    site_dir = f"{BUCKET}/{source['collection']}.parquet/{part['key']}={part['value']}"
    variables = list(source["variables"])
    qc = source.get("qc", {})
    if qc.get("mode") == "per_variable":
        wanted = variables + [f"{v}_quality_control" for v in variables]
    elif qc.get("mode") == "single":
        wanted = variables + [qc["column"]]
    else:
        wanted = variables
    wanted += ["LATITUDE", "LONGITUDE"]  # buoys drift on their mooring; map uses the latest fix

    warnings: list[str] = []
    files = [f for d in _candidate_partitions(s3, site_dir, start) for f in _list_parquet(s3, d)]
    if not files:
        raise RuntimeError(f"no parquet files under {site_dir} for window starting {start:%Y-%m-%d}")

    start_utc = _to_utc(start)
    tables = []
    for path in files:
        try:
            pf = pq.ParquetFile(path, filesystem=s3)
            schema = pf.schema_arrow
            time_idx = schema.get_field_index(TIME_COL)
            if time_idx < 0:
                continue
            fmax = _file_max_time(pf.metadata, time_idx)
            if fmax is not None and _to_utc(fmax) < start_utc:
                continue
            cols = [TIME_COL] + [c for c in wanted if schema.get_field_index(c) >= 0]
            tbl = pf.read(columns=cols)
        except (OSError, pa.ArrowException) as exc:
            # Likely mid-rewrite by the pipeline; the next harvest picks it up.
            warnings.append(f"skipped {path.rsplit('/', 1)[-1]}: {type(exc).__name__}: {exc}")
            continue
        time = tbl.column(TIME_COL)
        if time.type.tz is None:
            time = pc.assume_timezone(time, "UTC")
        tbl = tbl.set_column(0, TIME_COL, time)
        tables.append(tbl.filter(pc.greater_equal(time, pa.scalar(start_utc, type=time.type))))

    if not tables:
        raise RuntimeError(f"no readable rows in window for {site_dir}; " + "; ".join(warnings))
    df = pa.concat_tables(tables, promote_options="default").to_pandas()
    df = df.drop_duplicates(TIME_COL, keep="last").set_index(TIME_COL).sort_index()
    df.index = pd.DatetimeIndex(df.index).tz_convert("UTC")
    return df, warnings
