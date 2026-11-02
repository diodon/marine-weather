import SunCalc from "suncalc";
import { badge } from "./current";
import type { Tide } from "./data";
import { formatLocal, formatValue, TZ, withUnits } from "./format";

const HOUR = 3600;
const DAY_COUNT = 7;
const CHART_BEFORE = 6 * HOUR;
const CHART_AFTER = 42 * HOUR;
const CHART_HEIGHT = 170;
const LABEL_MIN_WIDTH = 480; // below this, high/low time labels would collide
const PAD = { top: 22, right: 8, bottom: 24, left: 36 };

// Required wording, from the Conditions of Use in BOM's tide table PDFs.
const BOM_DISCLAIMER = `
<p>The Bureau of Meteorology gives no warranty of any kind whether express, implied, statutory or otherwise in respect to the availability, accuracy, currency, completeness, quality or reliability of the information or that the information will be fit for any particular purpose or will not infringe any third party Intellectual Property rights.</p>
<p>The Bureau's liability for any loss, damage, cost or expense resulting from use of, or reliance on, the information is entirely excluded.</p>
<p>This product is based on Bureau of Meteorology information that has subsequently been modified. The Bureau does not necessarily support or endorse, or have any connection with, the product.</p>
<p>In respect of that part of the information which is sourced from the Bureau, and to the maximum extent permitted by law:</p>
<p>(i) The Bureau makes no representation and gives no warranty of any kind whether express, implied, statutory or otherwise in respect to the availability, accuracy, currency, completeness, quality or reliability of the information or that the information will be fit for any particular purpose or will not infringe any third party Intellectual Property rights; and</p>
<p>(ii) the Bureau's liability for any loss, damage, cost or expense resulting from use of, or reliance on, the information is entirely excluded.</p>`;

const clock = (t: number) => formatLocal(t, { day: undefined, month: undefined });
const weekday = (t: number) => formatLocal(t, { weekday: "short", day: undefined, month: undefined, hour: undefined, minute: undefined });
const metres = (h: number) => withUnits(formatValue(h, 2), "m");

interface SunDay {
  noon: number;
  sunrise: number;
  sunset: number;
}

/** Sun times for `count` Hobart calendar days, starting `first` days from today. */
function sunDays(now: number, lat: number, lon: number, first: number, count: number): SunDay[] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date(now * 1000));
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Array.from({ length: count }, (_, i) => {
    // 02:00 UTC is close to solar noon here; SunCalc returns the day around the instant it's given.
    const date = new Date(Date.UTC(part("year"), part("month") - 1, part("day") + first + i, 2));
    const times = SunCalc.getTimes(date, lat, lon);
    return { noon: date.getTime() / 1000, sunrise: times.sunrise.getTime() / 1000, sunset: times.sunset.getTime() / 1000 };
  });
}

function heightAt(tide: Tide, t: number): number | null {
  const i = tide.time.findIndex((x) => x >= t);
  if (i <= 0) return i === 0 && tide.time[0] === t ? tide.height[0] : null;
  const f = (t - tide.time[i - 1]) / (tide.time[i] - tide.time[i - 1]);
  return tide.height[i - 1] + f * (tide.height[i] - tide.height[i - 1]);
}

function tile(label: string, value: string, sub?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "tile tile-static";
  const l = document.createElement("span");
  l.className = "tile-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "tile-value";
  v.textContent = value;
  el.append(l, v);
  if (sub) {
    const s = document.createElement("span");
    s.className = "tile-sub";
    s.textContent = sub;
    el.append(s);
  }
  return el;
}

function renderChart(plot: HTMLElement, tide: Tide, nights: SunDay[], now: number) {
  const width = Math.max(plot.clientWidth, 280);
  const start = now - CHART_BEFORE;
  const end = now + CHART_AFTER;
  const inView = tide.time.map((t, i) => [t, tide.height[i]]).filter(([t]) => t >= start - HOUR && t <= end + HOUR);
  if (inView.length < 2) {
    plot.textContent = "No tide data for this period.";
    return;
  }
  const lo = Math.floor(Math.min(...inView.map(([, h]) => h)) * 2) / 2;
  const hi = Math.ceil(Math.max(...inView.map(([, h]) => h)) * 2) / 2;
  const x = (t: number) => PAD.left + ((t - start) / (end - start)) * (width - PAD.left - PAD.right);
  const y = (h: number) => PAD.top + ((hi - h) / (hi - lo || 1)) * (CHART_HEIGHT - PAD.top - PAD.bottom);
  const left = PAD.left;
  const right = width - PAD.right;

  let svg = `<clipPath id="tide-clip"><rect x="${left}" y="0" width="${right - left}" height="${CHART_HEIGHT}"/></clipPath>`;

  // Night bands, from each sunset to the next sunrise
  for (let i = 0; i + 1 < nights.length; i++) {
    const a = Math.max(nights[i].sunset, start);
    const b = Math.min(nights[i + 1].sunrise, end);
    if (b > a) svg += `<rect x="${x(a)}" y="${PAD.top}" width="${x(b) - x(a)}" height="${CHART_HEIGHT - PAD.top - PAD.bottom}" fill="var(--wash)"/>`;
  }
  for (let h = lo; h <= hi + 1e-6; h += 0.5) {
    svg += `<line x1="${left}" x2="${right}" y1="${y(h)}" y2="${y(h)}" stroke="var(--grid)"/>`;
    svg += `<text x="${left - 6}" y="${y(h) + 4}" text-anchor="end" class="tide-axis">${formatValue(h, 1)}</text>`;
  }
  // Day names under local noon keep the axis quiet.
  for (const d of nights) {
    if (d.noon >= start && d.noon <= end) {
      svg += `<text x="${x(d.noon)}" y="${CHART_HEIGHT - 6}" text-anchor="middle" class="tide-axis">${weekday(d.noon)}</text>`;
    }
  }
  const path = inView.map(([t, h], i) => `${i ? "L" : "M"}${x(t).toFixed(1)} ${y(h).toFixed(1)}`).join("");
  svg += `<path d="${path}" clip-path="url(#tide-clip)" fill="none" stroke="var(--text-secondary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  svg += `<line x1="${x(now)}" x2="${x(now)}" y1="${PAD.top}" y2="${CHART_HEIGHT - PAD.bottom}" stroke="var(--text-primary)" stroke-dasharray="3 3"/>`;
  svg += `<text x="${x(now)}" y="12" text-anchor="middle" class="tide-axis">Now</text>`;

  for (const e of tide.extremes) {
    if (e.time < start || e.time > end) continue;
    svg += `<circle cx="${x(e.time)}" cy="${y(e.height)}" r="4" fill="var(--text-secondary)" stroke="var(--surface-1)" stroke-width="2"/>`;
    if (width >= LABEL_MIN_WIDTH && Math.abs(e.time - now) > 2 * HOUR && x(e.time) > left + 26 && x(e.time) < right - 26) {
      const dy = e.type === "high" ? -9 : 17;
      svg += `<text x="${x(e.time)}" y="${y(e.height) + dy}" text-anchor="middle" class="tide-axis tide-label">${clock(e.time)}</text>`;
    }
  }
  svg += `<line class="tide-cursor" y1="${PAD.top}" y2="${CHART_HEIGHT - PAD.bottom}" stroke="var(--axis)" visibility="hidden"/>`;

  plot.innerHTML = `<svg width="${width}" height="${CHART_HEIGHT}" viewBox="0 0 ${width} ${CHART_HEIGHT}" role="img" aria-label="Predicted tide height from 6 hours ago to 42 hours ahead; the same high and low tides are in the table below">${svg}</svg>`;

  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  plot.append(tip);
  const svgEl = plot.querySelector("svg")!;
  const cursor = svgEl.querySelector<SVGLineElement>(".tide-cursor")!;
  svgEl.addEventListener("pointermove", (ev) => {
    const px = ev.clientX - svgEl.getBoundingClientRect().left;
    const t = start + ((px - left) / (right - left)) * (end - start);
    const h = t >= start && t <= end ? heightAt(tide, t) : null;
    if (h === null) {
      cursor.setAttribute("visibility", "hidden");
      tip.hidden = true;
      return;
    }
    cursor.setAttribute("x1", String(px));
    cursor.setAttribute("x2", String(px));
    cursor.setAttribute("visibility", "visible");
    tip.innerHTML = "<strong></strong><span></span>";
    tip.children[0].textContent = metres(h);
    tip.children[1].textContent = formatLocal(t, { weekday: "short" });
    tip.hidden = false;
    tip.style.top = "0";
    tip.style.left = `${Math.min(px + 10, width - tip.offsetWidth)}px`;
  });
  svgEl.addEventListener("pointerleave", () => {
    cursor.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
}

function renderTable(tide: Tide | null, days: SunDay[]): HTMLElement {
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const h of ["Day", "Sunrise", "Sunset", ...(tide ? ["High and low tides"] : [])]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.append(th);
  }
  const body = table.createTBody();
  const dayKey = (t: number) => formatLocal(t, { hour: undefined, minute: undefined });
  for (const d of days) {
    const row = body.insertRow();
    row.insertCell().textContent = formatLocal(d.noon, { weekday: "short", hour: undefined, minute: undefined });
    row.insertCell().textContent = clock(d.sunrise);
    row.insertCell().textContent = clock(d.sunset);
    if (tide) {
      row.insertCell().textContent = tide.extremes
        .filter((e) => dayKey(e.time) === dayKey(d.noon))
        .map((e) => `${e.type === "high" ? "High" : "Low"} ${clock(e.time)} (${metres(e.height)})`)
        .join(" · ") || "—";
    }
  }
  return table;
}

/** Tide & sun card. Sun times are computed here for the map centre; tide comes
 *  from the harvester, and "next" values are worked out against the clock so
 *  they stay right between harvests. */
export function renderTideSun(container: HTMLElement, tide: Tide | null, center: { lat: number; lon: number }): void {
  const now = Date.now() / 1000;
  const wasOpen = container.querySelector("details")?.open ?? false;
  const termsOpen = container.querySelector<HTMLDetailsElement>(".tide-terms")?.open ?? false;
  const [today] = sunDays(now, center.lat, center.lon, 0, 1);

  const card = document.createElement("article");
  card.className = "card station";
  const head = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = tide ? "Tide & sun" : "Sun";
  const desc = document.createElement("p");
  desc.className = "muted small";
  desc.textContent = tide
    ? "Bureau of Meteorology predictions for Hobart, about 14 km north of Blackmans Bay. Heights are above Lowest Astronomical Tide and exclude weather effects. High and low tides are BOM's values; “Tide now” and the curve between them are our estimate."
    : "Blackmans Bay";
  head.append(title, desc);
  if (tide?.status === "fallback") {
    const meta = document.createElement("p");
    meta.className = "station-meta small";
    meta.append(badge("serious", "Upstream error", `Showing last good harvest. ${tide.warnings.join(" ")}`));
    head.append(meta);
  }

  const tiles = document.createElement("div");
  tiles.className = "tiles";
  if (tide) {
    const next = (type: "high" | "low") => tide.extremes.find((e) => e.time > now && e.type === type);
    const upcoming = tide.extremes.find((e) => e.time > now);
    const height = heightAt(tide, now);
    tiles.append(tile("Tide now", height === null ? "—" : metres(height), upcoming && (upcoming.type === "high" ? "↑ rising" : "↓ falling")));
    for (const type of ["high", "low"] as const) {
      const e = next(type);
      tiles.append(tile(`Next ${type} tide`, e ? clock(e.time) : "—", e && `${metres(e.height)} · ${weekday(e.time)}`));
    }
  }
  tiles.append(
    tile("Sunrise", clock(today.sunrise)),
    tile("Sunset", clock(today.sunset)),
  );
  const daylight = Math.round((today.sunset - today.sunrise) / 60);
  tiles.append(tile("Daylight", `${Math.floor(daylight / 60)} h ${daylight % 60} min`));

  const details = document.createElement("details");
  details.open = wasOpen;
  details.innerHTML = `<summary class="small">${tide ? "Tide and sun table" : "Sun table"}, next ${DAY_COUNT} days</summary><div class="table-wrap"></div>`;
  details.querySelector(".table-wrap")!.append(renderTable(tide, sunDays(now, center.lat, center.lon, 0, DAY_COUNT)));

  const foot = document.createElement("footer");
  foot.className = "muted small";
  foot.innerHTML = tide
    ? `Tide predictions: © Commonwealth of Australia 2025–2026, <a href="https://www.bom.gov.au/australia/tides/#!/tas-hobart" target="_blank" rel="noopener">Bureau of Meteorology</a>. Not for navigation. Sun times are calculated. Shaded bands are night.<details class="tide-terms"><summary>Bureau of Meteorology disclaimer</summary>${BOM_DISCLAIMER}</details>`
    : "Sun times are calculated.";
  foot.querySelector<HTMLDetailsElement>(".tide-terms")?.toggleAttribute("open", termsOpen);

  card.append(head, tiles);
  let plot: HTMLElement | null = null;
  if (tide) {
    plot = document.createElement("div");
    plot.className = "plot tide-plot";
    card.append(plot);
  }
  card.append(details, foot);
  container.replaceChildren(card);
  // The chart is sized from its rendered width, so it's drawn once the card is in the page.
  if (plot && tide) renderChart(plot, tide, sunDays(now, center.lat, center.lon, -1, 4), now);
}
