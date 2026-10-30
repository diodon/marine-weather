import "./style.css";
import { ChartGrid, type ChartSpec } from "./charts";
import { renderCurrent, seriesKey } from "./current";
import { loadManifest, loadSources, type Manifest, type Source } from "./data";
import { formatAge, formatLocal } from "./format";
import { createMap, type StationMap } from "./map";

const POLL_MS = 5 * 60 * 1000;
const RANGES = [
  { hours: 24, label: "24 h" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];

// View state lives in the URL hash so a view can be shared as a link:
//   #r=72&q=0&v=derwent_b1:TEMP,storm_bay_wave:WSSH
interface State {
  rangeHours: number;
  includeQuestionable: boolean;
  selected: Set<string> | null; // null = the configured defaults
}

function readHash(): State {
  const p = new URLSearchParams(location.hash.slice(1));
  const r = Number(p.get("r"));
  return {
    rangeHours: RANGES.some((x) => x.hours === r) ? r : 72,
    includeQuestionable: p.get("q") === "1",
    selected: p.has("v") ? new Set(p.get("v")!.split(",").filter(Boolean)) : null,
  };
}

function writeHash(s: State) {
  const p = new URLSearchParams({ r: String(s.rangeHours), q: s.includeQuestionable ? "1" : "0" });
  if (s.selected) p.set("v", [...s.selected].join(","));
  history.replaceState(null, "", `#${p.toString().replace(/%3A/g, ":").replace(/%2C/g, ",")}`);
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

// Theme: an explicit choice (data-theme on <html>, saved per browser) wins
// over the OS setting. index.html applies the saved value before first paint.
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : darkQuery.matches;
};

function renderThemeToggle() {
  const dark = isDark();
  const btn = $("#theme");
  btn.setAttribute("aria-pressed", String(dark));
  btn.querySelector(".theme-icon")!.textContent = dark ? "☀" : "☾";
  btn.querySelector(".theme-label")!.textContent = dark ? "Light mode" : "Dark mode";
  btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
}

function applyTheme() {
  renderThemeToggle();
  map?.setDark(isDark());
  if (sources.length) charts.render(chartSpecs(), state); // chart colours are read from CSS tokens at build time
}

let manifest: Manifest;
let sources: Source[] = [];
let map: StationMap;
const state = readHash();
const charts = new ChartGrid($("#charts"));

function defaultSelection(): Set<string> {
  return new Set(
    sources.flatMap((s) => Object.entries(s.variables).filter(([, v]) => v.default).map(([k]) => seriesKey(s.id, k))),
  );
}

function selection(): Set<string> {
  return state.selected ?? defaultSelection();
}

function chartSpecs(): ChartSpec[] {
  const sel = selection();
  // Source/variable order from the config, not click order, so charts stay grouped by station.
  return sources.flatMap((source) =>
    Object.keys(source.variables)
      .filter((variable) => sel.has(seriesKey(source.id, variable)))
      .map((variable) => ({ key: seriesKey(source.id, variable), source, variable })),
  );
}

function toggle(key: string) {
  const sel = new Set(selection());
  sel.has(key) ? sel.delete(key) : sel.add(key);
  state.selected = sel;
  render();
}

function renderFilters() {
  const group = $("#range");
  group.replaceChildren(
    ...RANGES.map((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = r.label;
      b.setAttribute("aria-pressed", String(r.hours === state.rangeHours));
      b.addEventListener("click", () => {
        state.rangeHours = r.hours;
        render();
      });
      return b;
    }),
  );
  $<HTMLInputElement>("#questionable").checked = state.includeQuestionable;
}

function renderHeader() {
  const generated = Date.parse(manifest.generated_at) / 1000;
  $("#title").textContent = manifest.title;
  document.title = manifest.title;
  const el = $("#updated");
  el.textContent = `Data harvested ${formatLocal(generated)} (${formatAge(generated)}) · times in Hobart local time`;
  el.title = manifest.generated_at;
}

function render() {
  writeHash(state);
  renderHeader();
  renderFilters();
  renderCurrent($("#current"), sources, selection(), state.includeQuestionable, toggle);
  map.update(sources, state.includeQuestionable);
  charts.render(chartSpecs(), state);
}

async function refresh(force = false) {
  const next = await loadManifest();
  if (!force && manifest && next.generated_at === manifest.generated_at) {
    renderHeader(); // keep the "x min ago" honest
    renderCurrent($("#current"), sources, selection(), state.includeQuestionable, toggle);
    return;
  }
  document.body.classList.add("loading"); // previous render stays visible, dimmed
  try {
    sources = await loadSources(next);
    manifest = next;
    render();
  } finally {
    document.body.classList.remove("loading");
  }
}

async function start() {
  try {
    manifest = await loadManifest();
    sources = await loadSources(manifest);
  } catch (err) {
    $("#current").textContent = `Could not load data: ${(err as Error).message}`;
    return;
  }
  renderThemeToggle();
  map = createMap($("#map"), manifest, isDark(), (id) => {
    const card = document.getElementById(`station-${id}`);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card?.classList.add("flash");
    setTimeout(() => card?.classList.remove("flash"), 1200);
  });
  $<HTMLInputElement>("#questionable").addEventListener("change", (e) => {
    state.includeQuestionable = (e.target as HTMLInputElement).checked;
    render();
  });
  $("#reset").addEventListener("click", () => {
    state.selected = null;
    render();
  });
  $("#theme").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // storage unavailable (private mode etc.) — the toggle still works for this visit
    }
    applyTheme();
  });
  darkQuery.addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) applyTheme();
  });
  window.addEventListener("hashchange", () => {
    Object.assign(state, readHash());
    render();
  });
  render();
  setInterval(() => refresh().catch((e) => console.warn("refresh failed", e)), POLL_MS);
}

start();
