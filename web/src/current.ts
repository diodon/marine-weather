import { latestValue, type Source } from "./data";
import { compass, formatAge, formatLocal, formatValue, withUnits } from "./format";

export const seriesKey = (sourceId: string, variable: string) => `${sourceId}:${variable}`;

/** Current-conditions cards: one per source, one toggleable stat tile per
 *  variable. Pressing a tile adds/removes that variable's chart below. */
export function renderCurrent(
  container: HTMLElement,
  sources: Source[],
  selected: Set<string>,
  includeQuestionable: boolean,
  onToggle: (key: string) => void,
): void {
  const now = Date.now() / 1000;
  container.replaceChildren(
    ...sources.map((src) => {
      const card = document.createElement("article");
      card.className = "card station";
      card.id = `station-${src.id}`;
      card.style.setProperty("--c", `var(--series-${src.color})`);

      const head = document.createElement("header");
      const title = document.createElement("h3");
      const key = document.createElement("span");
      key.className = "key-line";
      key.setAttribute("aria-hidden", "true");
      title.append(key, document.createTextNode(src.name));
      const desc = document.createElement("p");
      desc.className = "muted small";
      desc.textContent = src.description;
      head.append(title, desc);

      const latest = src.latest_time ? Date.parse(src.latest_time) / 1000 : null;
      const meta = document.createElement("p");
      meta.className = "station-meta small";
      const age = document.createElement("span");
      age.textContent = latest
        ? `Last reading ${formatLocal(latest)} (${formatAge(latest, now)})`
        : "No readings in window";
      age.title = src.latest_time ?? "";
      meta.append(age);
      if (latest === null || now - latest > src.stale_after_hours * 3600) {
        meta.append(badge("warning", "Stale", `No new data for more than ${src.stale_after_hours} h`));
      }
      if (src.status === "fallback") {
        meta.append(badge("serious", "Upstream error", `Showing last good harvest. ${src.warnings.join(" ")}`));
      }
      head.append(meta);

      const tiles = document.createElement("div");
      tiles.className = "tiles";
      for (const [k, v] of Object.entries(src.variables)) {
        const sk = seriesKey(src.id, k);
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "tile";
        tile.setAttribute("aria-pressed", String(selected.has(sk)));
        tile.title = selected.has(sk) ? "Remove chart" : "Add chart";
        tile.addEventListener("click", () => onToggle(sk));

        const label = document.createElement("span");
        label.className = "tile-label";
        label.textContent = v.label;
        const value = document.createElement("span");
        value.className = "tile-value";
        const lv = latestValue(src, k, includeQuestionable);
        const digits = v.digits ?? 1;
        value.textContent = lv === null ? "—" : withUnits(formatValue(lv.value, digits), v.units);
        tile.append(label, value);
        if (lv && v.direction) {
          const sub = document.createElement("span");
          sub.className = "tile-sub";
          sub.textContent = `from ${compass(lv.value)}`;
          tile.append(sub);
        }
        if (lv && latest !== null && latest - lv.time > 3600) {
          const sub = document.createElement("span");
          sub.className = "tile-sub";
          sub.textContent = `at ${formatLocal(lv.time)}`;
          tile.append(sub);
        }
        if (lv?.questionable) {
          const sub = document.createElement("span");
          sub.className = "tile-sub";
          sub.textContent = "⚠ questionable";
          tile.append(sub);
        }
        tiles.append(tile);
      }

      const foot = document.createElement("footer");
      foot.className = "muted small";
      foot.textContent = src.attribution + (src.collection ? ` · ${src.collection}` : "");
      if (src.link) {
        const a = document.createElement("a");
        a.href = src.link;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "source";
        foot.append(" · ", a);
      }

      card.append(head, tiles, foot);
      return card;
    }),
  );
}

function badge(kind: "warning" | "serious", label: string, title: string): HTMLElement {
  const b = document.createElement("span");
  b.className = `badge badge-${kind}`;
  b.title = title;
  b.textContent = `${kind === "warning" ? "⏱" : "⚠"} ${label}`;
  return b;
}
