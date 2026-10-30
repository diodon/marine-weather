import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { latestValue, type Source } from "./data";
import { compass, formatLocal, formatValue, withUnits } from "./format";

const TZ = "Australia/Hobart";
const SYNC_KEY = "marineweather";
const CHART_HEIGHT = 180;
const TABLE_MAX_ROWS = 500;

export interface ChartSpec {
  key: string;
  source: Source;
  variable: string;
}

interface Options {
  rangeHours: number;
  includeQuestionable: boolean;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function alpha(hex: string, a: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const tickParts = new Intl.DateTimeFormat("en-AU", {
  timeZone: TZ, weekday: "short", day: "numeric", hour: "numeric", hourCycle: "h23",
});

/** One-line x tick in Hobart time: "Thu 30" at midnight, "6 am" otherwise. */
function timeTick(ts: number): string {
  const p = Object.fromEntries(tickParts.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour);
  if (hour === 0) return `${p.weekday} ${p.day}`;
  return hour === 12 ? "12 pm" : hour > 12 ? `${hour - 12} pm` : `${hour} am`;
}

/** Points in [start, end], with questionable values removed or split out. */
function sliceSeries(src: Source, variable: string, start: number, includeQuestionable: boolean) {
  const v = src.variables[variable];
  const q = new Set(v.questionable ?? []);
  const xs: number[] = [];
  const ys: (number | null)[] = [];
  const qs: (number | null)[] = [];
  let hidden = 0;
  for (let i = 0; i < src.time.length; i++) {
    if (src.time[i] < start) continue;
    const isQ = q.has(i) && v.values[i] !== null;
    if (isQ && !includeQuestionable) hidden++;
    xs.push(src.time[i]);
    ys.push(isQ && !includeQuestionable ? null : v.values[i]);
    qs.push(isQ && includeQuestionable ? v.values[i] : null);
  }
  return { xs, ys, qs, hidden };
}

/** Readout for the hovered X: value first (strong), then time — never gates
 *  a value, the table view below each chart holds the same numbers. */
function tooltipPlugin(spec: ChartSpec): uPlot.Plugin {
  const v = spec.source.variables[spec.variable];
  let tip: HTMLDivElement;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className = "chart-tip";
        tip.hidden = true;
        u.over.append(tip);
      },
      setCursor: (u) => {
        const idx = u.cursor.idx;
        const val = idx == null ? null : (u.data[1][idx] ?? u.data[2]?.[idx] ?? null);
        if (idx == null || val == null) {
          tip.hidden = true;
          return;
        }
        const digits = v.digits ?? 1;
        let text = withUnits(formatValue(val, digits), v.units);
        if (v.direction) text += ` (${compass(val)})`;
        tip.replaceChildren();
        const strong = document.createElement("strong");
        strong.textContent = text;
        const when = document.createElement("span");
        when.textContent = formatLocal(u.data[0][idx]);
        tip.append(strong, when);
        if (u.data[2]?.[idx] != null) tip.append(Object.assign(document.createElement("span"), { textContent: "⚠ questionable" }));
        tip.hidden = false;
        const left = u.valToPos(u.data[0][idx], "x");
        const flip = left > u.over.clientWidth - 140;
        tip.style.left = `${flip ? left - 12 : left + 12}px`;
        tip.style.transform = flip ? "translateX(-100%)" : "";
        tip.style.top = `${Math.max(0, u.valToPos(val, "y") - 24)}px`;
      },
    },
  };
}

function buildChart(el: HTMLElement, spec: ChartSpec, opts: Options, start: number, end: number) {
  const { source, variable } = spec;
  const v = source.variables[variable];
  const color = css(`--series-${source.color}`);
  const muted = css("--text-muted");
  const grid = css("--grid");
  const axis = css("--axis");
  const surface = css("--surface-1");
  const { xs, ys, qs, hidden } = sliceSeries(source, variable, start, opts.includeQuestionable);
  const font = `11px ${css("--font")}`;
  const axisBase: uPlot.Axis = {
    stroke: muted,
    font,
    grid: { stroke: grid, width: 1 },
    ticks: { stroke: axis, width: 1, size: 4 },
  };

  const yAxis: uPlot.Axis = { ...axisBase, size: 52 };
  // A flat or single-point series would otherwise auto-range from zero.
  const yScale: uPlot.Scale = {
    range: (_u, min, max) => (min === max ? [min - 1, max + 1] : uPlot.rangeNum(min, max, 0.1, true)),
  };
  if (v.direction) {
    yScale.range = [0, 360];
    yAxis.splits = () => [0, 90, 180, 270, 360];
    yAxis.values = (_u, splits) => splits.map((d) => compass(d));
  }

  const main: uPlot.Series = {
    label: v.label,
    stroke: color,
    width: 2,
    spanGaps: false,
  };
  if (v.direction) {
    // Direction wraps at 360°: draw points, not a line that would slash across the plot.
    main.paths = () => null;
    main.points = { show: true, size: 6, fill: color, stroke: color };
  } else {
    main.fill = alpha(color, 0.1);
    main.points = { show: (_u, _si, i0, i1) => i1 - i0 < 60, size: 8, fill: color, stroke: surface, width: 2 };
  }

  const data: uPlot.AlignedData = opts.includeQuestionable ? [xs, ys, qs] : [xs, ys];
  const series: uPlot.Series[] = [{}, main];
  if (opts.includeQuestionable) {
    series.push({
      label: "questionable",
      paths: () => null,
      points: { show: true, size: 8, fill: surface, stroke: muted, width: 2 },
    });
  }

  const u = new uPlot(
    {
      width: el.clientWidth || 600,
      height: CHART_HEIGHT,
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), TZ),
      legend: { show: false },
      cursor: {
        y: false,
        sync: { key: SYNC_KEY },
        points: { size: 8, fill: color, stroke: surface, width: 2 },
        drag: { x: false, y: false },
      },
      scales: { x: { time: true, range: [start, end] }, y: yScale },
      axes: [{ ...axisBase, size: 32, values: (_u, splits) => splits.map(timeTick) }, yAxis],
      series,
      plugins: [tooltipPlugin(spec)],
    },
    data,
    el,
  );
  return { u, hidden, count: ys.filter((y) => y !== null).length };
}

function renderTable(details: HTMLDetailsElement, spec: ChartSpec, opts: Options, start: number) {
  const v = spec.source.variables[spec.variable];
  const { xs, ys, qs } = sliceSeries(spec.source, spec.variable, start, opts.includeQuestionable);
  const table = document.createElement("table");
  const thead = table.createTHead().insertRow();
  for (const h of ["Time (Hobart)", withUnits(v.label, v.units ? `(${v.units})` : "")]) {
    const th = document.createElement("th");
    th.textContent = h;
    thead.append(th);
  }
  const body = table.createTBody();
  let rows = 0;
  for (let i = xs.length - 1; i >= 0 && rows < TABLE_MAX_ROWS; i--) {
    const val = ys[i] ?? qs[i];
    if (val == null) continue;
    const tr = body.insertRow();
    tr.insertCell().textContent = formatLocal(xs[i], { year: "numeric" });
    tr.insertCell().textContent =
      formatValue(val, v.digits ?? 1) + (v.direction ? ` ${compass(val)}` : "") + (qs[i] != null ? " ⚠" : "");
    rows++;
  }
  details.querySelector(".table-wrap")!.replaceChildren(table);
  const note = details.querySelector(".table-note")!;
  note.textContent = rows === TABLE_MAX_ROWS ? `Newest ${TABLE_MAX_ROWS} readings shown.` : "";
}

/** Small multiples — one chart per selected variable (each has its own units,
 *  so never a shared or second y-axis), all on the same time range with a
 *  synced crosshair. */
export class ChartGrid {
  private plots: uPlot[] = [];
  private observer = new ResizeObserver((entries) => {
    for (const e of entries) {
      const plot = this.plots.find((p) => p.root.parentElement === e.target);
      if (plot) plot.setSize({ width: e.contentRect.width, height: CHART_HEIGHT });
    }
  });

  constructor(private container: HTMLElement) {}

  render(specs: ChartSpec[], opts: Options) {
    this.destroy();
    const end = Date.now() / 1000;
    const start = end - opts.rangeHours * 3600;

    if (!specs.length) {
      const empty = document.createElement("p");
      empty.className = "muted empty";
      empty.textContent = "Select a value above to chart its history.";
      this.container.replaceChildren(empty);
      return;
    }

    const cards = specs.map((spec) => {
      const { source, variable } = spec;
      const v = source.variables[variable];
      const card = document.createElement("article");
      card.className = "card chart-card";
      card.style.setProperty("--c", `var(--series-${source.color})`);

      const head = document.createElement("header");
      const titles = document.createElement("div");
      const h = document.createElement("h3");
      h.textContent = v.units ? `${v.label} (${v.units})` : v.label;
      const sub = document.createElement("p");
      sub.className = "small muted";
      const key = document.createElement("span");
      key.className = "key-line";
      key.setAttribute("aria-hidden", "true");
      sub.append(key, document.createTextNode(source.name));
      titles.append(h, sub);
      const latest = latestValue(source, variable, opts.includeQuestionable);
      const value = document.createElement("p");
      value.className = "chart-latest";
      value.textContent = latest ? withUnits(formatValue(latest.value, v.digits ?? 1), v.units) : "—";
      head.append(titles, value);

      const plotEl = document.createElement("div");
      plotEl.className = "plot";
      const note = document.createElement("p");
      note.className = "small muted chart-note";

      const details = document.createElement("details");
      details.innerHTML = '<summary class="small">Data table</summary><p class="small muted table-note"></p><div class="table-wrap"></div>';
      details.addEventListener("toggle", () => details.open && renderTable(details, spec, opts, start), { once: true });

      card.append(head, plotEl, note, details);
      return { card, plotEl, note, spec };
    });

    this.container.replaceChildren(...cards.map((c) => c.card));
    for (const { plotEl, note, spec } of cards) {
      const { u, hidden, count } = buildChart(plotEl, spec, opts, start, end);
      this.plots.push(u);
      this.observer.observe(plotEl);
      const notes: string[] = [];
      if (count === 0) notes.push("No readings in this time range.");
      if (hidden) notes.push(`${hidden} questionable reading${hidden > 1 ? "s" : ""} hidden.`);
      note.textContent = notes.join(" ");
    }
  }

  destroy() {
    this.observer.disconnect();
    for (const p of this.plots) p.destroy();
    this.plots = [];
  }
}
