// Shapes of the files the harvester writes to data/ (see harvester/src/harvester/cli.py).

export interface Variable {
  label: string;
  units: string;
  digits?: number;
  direction?: boolean;
  default?: boolean;
  values: (number | null)[];
  /** Indices into `time` whose QC flag was "questionable" (3). */
  questionable?: number[];
}

export interface Source {
  id: string;
  name: string;
  kind: "aodn_parquet" | "bom_obs";
  description: string;
  color: number;
  lat: number;
  lon: number;
  link?: string;
  attribution: string;
  collection?: string;
  stale_after_hours: number;
  generated_at: string;
  latest_time: string | null;
  status: "ok" | "fallback";
  warnings: string[];
  /** Unix seconds, ascending. */
  time: number[];
  variables: Record<string, Variable>;
}

export interface ManifestSource {
  id: string;
  name: string;
  file: string;
  color: number;
  lat: number;
  lon: number;
  latest_time: string | null;
  status: "ok" | "fallback";
  stale_after_hours: number;
}

export interface Manifest {
  title: string;
  center: { lon: number; lat: number; zoom: number };
  window_days: number;
  generated_at: string;
  sources: ManifestSource[];
}

const DATA_BASE = "data/";

async function getJson<T>(path: string): Promise<T> {
  // The harvester republishes every run; never let the browser serve a stale copy.
  const res = await fetch(`${DATA_BASE}${path}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const loadManifest = () => getJson<Manifest>("manifest.json");

export async function loadSources(manifest: Manifest): Promise<Source[]> {
  return Promise.all(manifest.sources.map((s) => getJson<Source>(s.file)));
}

/** Latest non-null value of a variable, optionally skipping questionable points. */
export function latestValue(
  source: Source,
  key: string,
  includeQuestionable: boolean,
): { value: number; time: number; questionable: boolean } | null {
  const v = source.variables[key];
  const q = new Set(v.questionable ?? []);
  for (let i = v.values.length - 1; i >= 0; i--) {
    const val = v.values[i];
    if (val === null) continue;
    if (!includeQuestionable && q.has(i)) continue;
    return { value: val, time: source.time[i], questionable: q.has(i) };
  }
  return null;
}
