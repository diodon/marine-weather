import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { latestValue, type Manifest, type Source } from "./data";
import { compass, formatValue, withUnits } from "./format";

// OpenFreeMap vector styles: keyless, light and dark variants matching the
// page theme; the styles carry their own OpenStreetMap attribution.
const basemap = (dark: boolean) => `https://tiles.openfreemap.org/styles/${dark ? "dark" : "positron"}`;

export interface StationMap {
  update(sources: Source[], includeQuestionable: boolean): void;
  setDark(dark: boolean): void;
}

/** One marker per source: series-coloured dot, its name, its headline value
 *  and — when the source has a direction variable — an arrow showing where the
 *  wind / waves are heading (direction + 180°, since both are reported "from"). */
export function createMap(
  container: HTMLElement,
  manifest: Manifest,
  dark: boolean,
  onSelect: (sourceId: string) => void,
): StationMap {
  const map = new maplibregl.Map({
    container,
    style: basemap(dark),
    center: [manifest.center.lon, manifest.center.lat],
    zoom: manifest.center.zoom,
    attributionControl: { compact: true },
    cooperativeGestures: true,
  });
  // Keep Blackmans Bay at the centre but zoom out far enough to show every
  // station: fit bounds that include each station and its mirror image
  // through the centre.
  const { lon: cx, lat: cy } = manifest.center;
  const bounds = new maplibregl.LngLatBounds([cx, cy], [cx, cy]);
  for (const s of manifest.sources) {
    bounds.extend([s.lon, s.lat]).extend([2 * cx - s.lon, 2 * cy - s.lat]);
  }
  map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 40, right: 170 }, maxZoom: manifest.center.zoom, animate: false });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  const place = document.createElement("div");
  place.className = "map-place";
  place.textContent = "Blackmans Bay";
  new maplibregl.Marker({ element: place, anchor: "left" })
    .setLngLat([manifest.center.lon, manifest.center.lat])
    .addTo(map);

  const markers = new Map<string, { el: HTMLElement; marker: maplibregl.Marker }>();
  for (const s of manifest.sources) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "map-marker";
    el.style.setProperty("--c", `var(--series-${s.color})`);
    el.innerHTML = '<span class="map-arrow" aria-hidden="true"></span><span class="map-dot" aria-hidden="true"></span><span class="map-label"><strong></strong><span></span></span>';
    el.querySelector("strong")!.textContent = s.name;
    el.addEventListener("click", () => onSelect(s.id));
    const marker = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(map);
    markers.set(s.id, { el, marker });
  }

  return {
    update(sources, includeQuestionable) {
      for (const src of sources) {
        const m = markers.get(src.id);
        if (!m) continue;
        m.marker.setLngLat([src.lon, src.lat]);
        const keys = Object.keys(src.variables);
        const headlineKey = keys.find((k) => !src.variables[k].direction);
        const dirKey = keys.find((k) => src.variables[k].direction);
        const parts: string[] = [];
        if (headlineKey) {
          const v = src.variables[headlineKey];
          const latest = latestValue(src, headlineKey, includeQuestionable);
          parts.push(`${v.label} ${withUnits(formatValue(latest?.value, v.digits ?? 1), v.units)}`);
        }
        const arrow = m.el.querySelector<HTMLElement>(".map-arrow")!;
        const dir = dirKey ? latestValue(src, dirKey, includeQuestionable) : null;
        if (dir) {
          arrow.style.display = "";
          arrow.style.transform = `rotate(${dir.value + 180}deg)`;
          parts.push(`from ${compass(dir.value)}`);
        } else {
          arrow.style.display = "none";
        }
        m.el.querySelector(".map-label > span")!.textContent = parts.join(" · ");
        m.el.setAttribute("aria-label", `${src.name}: ${parts.join(", ")}. Show current values.`);
      }
    },
    setDark(isDark) {
      map.setStyle(basemap(isDark));
    },
  };
}
