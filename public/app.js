const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function s(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

const pct = (ratio, digits = 1) => (ratio === null ? "–" : `${(ratio * 100).toFixed(digits)}%`);
const int = new Intl.NumberFormat("en");
const dayFmt = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" });
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SERIES = [
  { key: "long", label: "Long-distance", color: "var(--series-1)" },
  { key: "commuter", label: "Commuter", color: "var(--series-2)" },
];
const SEQ_STEPS = 7;

// ---- tooltip: one element, shared by every chart ----

const tooltip = $("tooltip");

function showTip(event, title, rows) {
  tooltip.replaceChildren(
    h("strong", {}, title),
    ...rows.map((row) =>
      h(
        "span",
        { class: "row" },
        row.color && h("span", { class: "swatch", style: `background:${row.color}` }),
        row.text,
      ),
    ),
  );
  tooltip.hidden = false;
  const box = tooltip.getBoundingClientRect();
  const x = Math.min(event.clientX + 14, window.innerWidth - box.width - 8);
  const y = event.clientY - box.height - 12;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${y < 8 ? event.clientY + 16 : y}px`;
}

function hideTip() {
  tooltip.hidden = true;
}

function tip(el, title, rows) {
  el.addEventListener("pointermove", (event) => showTip(event, title, rows()));
  el.addEventListener("pointerleave", hideTip);
}

function emptyNote(text) {
  return h("p", { class: "empty-note" }, text);
}

/** Sequential colour: one hue, the share mapped onto SEQ_STEPS steps of it. */
function seqColor(value, max) {
  const step = Math.min(SEQ_STEPS - 1, Math.floor((value / max) * SEQ_STEPS));
  return `var(--seq-${step})`;
}

/** A round upper bound for the colour scale, so the legend reads cleanly. */
function niceMax(value) {
  return Math.max(0.05, Math.ceil(value * 20) / 20);
}

function rampLegend(el, max, what) {
  el.replaceChildren(
    "0%",
    h(
      "span",
      { class: "ramp", "aria-hidden": "true" },
      Array.from({ length: SEQ_STEPS }, (_, i) =>
        h("span", { style: `background:var(--seq-${i})` }),
      ),
    ),
    `${Math.round(max * 100)}%+ ${what}`,
  );
}

// ---- stat tiles ----

function renderTiles(data) {
  const t = data.totals;
  const tile = (label, value, note) =>
    h(
      "div",
      { class: "tile" },
      h("div", { class: "tile-label" }, label),
      h("div", { class: "tile-value" }, value),
      h("div", { class: "tile-note" }, note),
    );
  $("tiles").replaceChildren(
    tile("On time", pct(t.onTime), `of ${int.format(t.measured)} completed runs`),
    tile(
      "Typical delay",
      t.medianDelay === null ? "–" : `${t.medianDelay} min`,
      t.p90Delay === null
        ? "median at final stop"
        : `median; 1 in 10 runs is ${t.p90Delay}+ min late`,
    ),
    tile(
      "Mean delay",
      t.meanDelay === null ? "–" : `${t.meanDelay.toFixed(1)} min`,
      "early arrivals count as zero",
    ),
    tile("Cancelled", pct(t.cancelled), `of ${int.format(t.runs)} scheduled runs`),
  );
}

// ---- daily line chart ----

function renderDaily(data) {
  const el = $("daily");
  const MIN_RUNS = 20; // a day with a handful of finished runs is noise, not a point
  const dates = [...new Set(data.daily.map((d) => d.date))].sort();
  const series = SERIES.map((meta) => ({
    ...meta,
    points: dates.map((date) => {
      const row = data.daily.find((d) => d.date === date && d.category === meta.key);
      return row && row.measured >= MIN_RUNS
        ? { date, value: 1 - row.late / row.measured, measured: row.measured }
        : { date, value: null };
    }),
  })).filter((line) => line.points.some((p) => p.value !== null));

  $("daily-legend").replaceChildren(
    ...series.map((line) =>
      h(
        "span",
        { class: "legend-item" },
        h("span", { class: "swatch", style: `background:${line.color}` }),
        line.label,
      ),
    ),
  );
  $("daily-sub").textContent =
    `Share of completed runs arriving on time, by departure date. Late means ${data.thresholds.long}+ min (long-distance) or ${data.thresholds.commuter}+ min (commuter).`;

  if (series.length === 0 || dates.length < 2) {
    el.replaceChildren(emptyNote("Not enough days collected yet for a trend."));
    $("daily-table").replaceChildren();
    return;
  }

  const W = 1040;
  const H = 260;
  const m = { top: 12, right: 96, bottom: 26, left: 40 };
  const values = series.flatMap((line) =>
    line.points.map((p) => p.value).filter((v) => v !== null),
  );
  const lo = Math.max(0, Math.floor((Math.min(...values) - 0.02) * 20) / 20);
  const x = (i) => m.left + (i / (dates.length - 1)) * (W - m.left - m.right);
  const y = (v) => m.top + (1 - (v - lo) / (1 - lo)) * (H - m.top - m.bottom);
  const svg = s("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": "On-time share by day",
  });

  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((1 - lo) * i) / ticks;
    svg.append(
      s("line", {
        class: i === 0 ? "baseline" : "gridline",
        x1: m.left,
        x2: W - m.right,
        y1: y(v),
        y2: y(v),
      }),
      s("text", { x: m.left - 8, y: y(v) + 4, "text-anchor": "end" }, `${Math.round(v * 100)}%`),
    );
  }
  const every = Math.ceil(dates.length / 8);
  dates.forEach((date, i) => {
    if (i % every !== 0 && i !== dates.length - 1) return;
    if (i !== dates.length - 1 && dates.length - 1 - i < every / 2) return;
    svg.append(
      s("text", { x: x(i), y: H - 6, "text-anchor": "middle" }, dayFmt.format(new Date(date))),
    );
  });

  // Direct labels at the line ends, nudged apart if they would collide.
  const ends = series
    .map((line) => {
      const index = line.points.findLastIndex((p) => p.value !== null);
      return { line, index, yPos: y(line.points[index].value) };
    })
    .sort((a, b) => a.yPos - b.yPos);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].yPos - ends[i - 1].yPos < 14) ends[i].yPos = ends[i - 1].yPos + 14;
  }

  for (const line of series) {
    let d = "";
    let pen = false;
    line.points.forEach((p, i) => {
      if (p.value === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`;
      pen = true;
    });
    svg.append(s("path", { class: "line", d, stroke: line.color }));
  }
  for (const end of ends) {
    svg.append(s("text", { class: "label", x: x(end.index) + 8, y: end.yPos + 4 }, end.line.label));
  }

  // Hover layer: a crosshair that snaps to the nearest day.
  const cross = s("line", {
    class: "crosshair",
    y1: m.top,
    y2: H - m.bottom,
    visibility: "hidden",
  });
  const dots = series.map((line) =>
    s("circle", { class: "dot", r: 4, fill: line.color, visibility: "hidden" }),
  );
  const hit = s("rect", {
    class: "hit",
    x: m.left,
    y: m.top,
    width: W - m.left - m.right,
    height: H - m.top - m.bottom,
  });
  svg.append(cross, ...dots, hit);
  hit.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const i = Math.max(
      0,
      Math.min(
        dates.length - 1,
        Math.round(((px - m.left) / (W - m.left - m.right)) * (dates.length - 1)),
      ),
    );
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    series.forEach((line, k) => {
      const p = line.points[i];
      dots[k].setAttribute("visibility", p.value === null ? "hidden" : "visible");
      if (p.value !== null) {
        dots[k].setAttribute("cx", x(i));
        dots[k].setAttribute("cy", y(p.value));
      }
    });
    showTip(
      event,
      dayFmt.format(new Date(dates[i])),
      series.map((line) => {
        const p = line.points[i];
        return {
          color: line.color,
          text: `${line.label}: ${p.value === null ? "too few runs" : `${pct(p.value)} of ${p.measured}`}`,
        };
      }),
    );
  });
  hit.addEventListener("pointerleave", () => {
    hideTip();
    cross.setAttribute("visibility", "hidden");
    for (const dot of dots) dot.setAttribute("visibility", "hidden");
  });

  el.replaceChildren(svg);

  $("daily-table").replaceChildren(
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", {}, "Date"),
          series.map((line) => h("th", { class: "num" }, line.label)),
        ),
      ),
      h(
        "tbody",
        {},
        dates.map((date, i) =>
          h(
            "tr",
            {},
            h("td", {}, date),
            series.map((line) => h("td", { class: "num" }, pct(line.points[i].value))),
          ),
        ),
      ),
    ),
  );
}

// ---- weekday × hour heatmap ----

function renderHeatmap(data) {
  const el = $("heatmap");
  const MIN_RUNS = 10;
  const cells = data.heatmap.filter((c) => c.measured >= MIN_RUNS);
  if (cells.length === 0) {
    el.replaceChildren(emptyNote("Not enough completed runs yet."));
    $("heatmap-legend").replaceChildren();
    return;
  }
  const max = niceMax(Math.max(...cells.map((c) => c.late / c.measured)));
  const byKey = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c]));

  const size = 19;
  const left = 34;
  const top = 4;
  const W = left + 24 * size;
  const H = top + 7 * size + 18;
  const svg = s("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": "Late share by weekday and hour",
  });

  for (let dow = 0; dow < 7; dow++) {
    svg.append(
      s(
        "text",
        { x: left - 6, y: top + dow * size + size / 2 + 4, "text-anchor": "end" },
        WEEKDAYS[dow],
      ),
    );
    for (let hour = 0; hour < 24; hour++) {
      const cell = byKey.get(`${dow}:${hour}`);
      const rect = s("rect", {
        class: cell ? "cell" : "cell empty",
        x: left + hour * size,
        y: top + dow * size,
        width: size,
        height: size,
        rx: 3,
      });
      if (cell) rect.setAttribute("fill", seqColor(cell.late / cell.measured, max));
      tip(
        rect,
        `${WEEKDAYS[dow]} ${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59`,
        () =>
          cell
            ? [
                { text: `${pct(cell.late / cell.measured)} late` },
                { text: `${int.format(cell.measured)} completed runs` },
              ]
            : [{ text: "Too few runs to say" }],
      );
      svg.append(rect);
    }
  }
  for (const hour of [0, 6, 12, 18, 23]) {
    svg.append(
      s(
        "text",
        { x: left + hour * size + size / 2, y: H - 4, "text-anchor": "middle" },
        String(hour).padStart(2, "0"),
      ),
    );
  }
  el.replaceChildren(svg);
  rampLegend($("heatmap-legend"), max, "late");
}

// ---- station map ----

function renderMap(data) {
  const el = $("map");
  const stations = data.stations;
  if (stations.length === 0) {
    el.replaceChildren(emptyNote("Not enough arrivals collected yet."));
    $("map-legend").replaceChildren();
    return;
  }
  // Equirectangular projection, with longitude squeezed for Finland's latitude.
  const lats = stations.map((st) => st.lat);
  const lons = stations.map((st) => st.lon);
  const squeeze = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  const spanX = (Math.max(...lons) - Math.min(...lons)) * squeeze || 1;
  const spanY = Math.max(...lats) - Math.min(...lats) || 1;
  const H = 440;
  const pad = 14;
  const scale = (H - pad * 2) / spanY;
  const W = spanX * scale + pad * 2;
  const x = (lon) => pad + (lon - Math.min(...lons)) * squeeze * scale;
  const y = (lat) => pad + (Math.max(...lats) - lat) * scale;

  // Scale to the 95th percentile: one tiny halt where half the trains are late
  // would otherwise wash every other station out to the lightest step.
  const shares = stations.map((st) => st.late / st.measured).sort((p, q) => p - q);
  const max = niceMax(shares[Math.floor(shares.length * 0.95)] ?? 0);
  const busiest = Math.max(...stations.map((st) => st.measured));
  const svg = s("svg", {
    viewBox: `0 0 ${W.toFixed(0)} ${H}`,
    role: "img",
    "aria-label": "Late arrivals by station",
  });

  // Busiest first, so small stations are drawn on top and stay hoverable.
  for (const st of [...stations].sort((a, b) => b.measured - a.measured)) {
    const dot = s("circle", {
      class: "station",
      cx: x(st.lon).toFixed(1),
      cy: y(st.lat).toFixed(1),
      r: (3.5 + 6 * Math.sqrt(st.measured / busiest)).toFixed(1),
      fill: seqColor(st.late / st.measured, max),
    });
    tip(dot, st.name, () => [
      { text: `${pct(st.late / st.measured)} of arrivals late` },
      { text: `${st.meanDelay.toFixed(1)} min mean delay` },
      { text: `${int.format(st.measured)} arrivals measured` },
    ]);
    svg.append(dot);
  }
  el.replaceChildren(svg);
  rampLegend($("map-legend"), max, "late · dot size = arrivals");
}

// ---- causes bar chart ----

function renderCauses(data) {
  const el = $("causes");
  const { lateRuns, lateRunsWithCause, byCategory } = data.causes;
  $("causes-sub").textContent =
    lateRuns === 0
      ? "No late runs in this period."
      : `A cause was recorded for ${int.format(lateRunsWithCause)} of ${int.format(lateRuns)} late runs (${pct(lateRunsWithCause / lateRuns, 0)}). A run with two causes counts under both.`;
  const rows = byCategory.slice(0, 8);
  if (rows.length === 0) {
    el.replaceChildren(emptyNote("No causes recorded."));
    return;
  }

  const W = 500;
  const rowH = 30;
  const labelW = 210;
  const valueW = 46;
  const H = rows.length * rowH;
  const max = rows[0].lateRuns;
  const svg = s("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": "Late runs by recorded cause",
  });
  rows.forEach((row, i) => {
    const width = Math.max(2, (row.lateRuns / max) * (W - labelW - valueW));
    const cy = i * rowH + rowH / 2;
    const label = s(
      "text",
      { class: "label", x: labelW - 10, y: cy + 4, "text-anchor": "end" },
      row.label,
    );
    const bar = s("path", {
      class: "bar",
      // Square at the baseline, rounded at the data end.
      d: `M${labelW} ${cy - 8}h${Math.max(0, width - 4)}a4 4 0 0 1 4 4v8a4 4 0 0 1 -4 4h${-Math.max(0, width - 4)}z`,
    });
    const hit = s("rect", { class: "hit", x: 0, y: i * rowH, width: W, height: rowH });
    tip(hit, row.label, () => [
      { text: `${int.format(row.lateRuns)} late runs` },
      { text: `Feed category ${row.code}: ${row.nameFi}` },
    ]);
    svg.append(
      label,
      bar,
      s("text", { class: "value", x: labelW + width + 6, y: cy + 4 }, int.format(row.lateRuns)),
      hit,
    );
  });
  svg.append(s("line", { class: "baseline", x1: labelW, x2: labelW, y1: 0, y2: H }));
  el.replaceChildren(svg);
}

// ---- tables ----

function trainId(train) {
  return train.line ? `${train.line} ${train.number}` : `${train.type} ${train.number}`;
}

function renderWorst(data) {
  const rows = data.worstTrains;
  $("worst-sub").textContent = "Train numbers with enough completed runs in the period to compare";
  if (rows.length === 0) {
    $("worst").replaceChildren(emptyNote("No train has enough runs yet."));
    return;
  }
  $("worst").replaceChildren(
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", {}, "Train"),
          h("th", {}, "Route"),
          h("th", { class: "num" }, "On time"),
          h("th", { class: "num" }, "Mean"),
          h("th", { class: "num" }, "Runs"),
        ),
      ),
      h(
        "tbody",
        {},
        rows.map((t) =>
          h(
            "tr",
            {},
            h("td", { class: "train-id" }, trainId(t)),
            h("td", { class: "route" }, `${t.origin} → ${t.destination}`),
            h("td", { class: "num" }, pct(1 - t.late / t.measured, 0)),
            h("td", { class: "num" }, `${t.meanDelay.toFixed(0)} min`),
            h("td", { class: "num" }, t.measured),
          ),
        ),
      ),
    ),
  );
}

function renderLive(live) {
  const seen = live.lastPollAt
    ? `feed checked ${Math.max(0, Math.round((live.at - live.lastPollAt) / 1000))}s ago`
    : "live collection is not running";
  $("live-sub").textContent =
    `${int.format(live.running)} trains on the network, most delayed first · ${seen}`;
  if (live.trains.length === 0) {
    $("live").replaceChildren(emptyNote("No running trains reported yet."));
    return;
  }
  $("live").replaceChildren(
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", {}, "Train"),
          h("th", {}, "Route"),
          h("th", {}, "Last seen at"),
          h("th", {}, "Status"),
        ),
      ),
      h(
        "tbody",
        {},
        live.trains.map((t) => {
          const late = t.delay >= live.thresholds[t.category];
          return h(
            "tr",
            {},
            h("td", { class: "train-id" }, trainId(t)),
            h("td", { class: "route" }, `${t.origin ?? "?"} → ${t.destination ?? "?"}`),
            h("td", {}, t.lastStation ?? "–"),
            h(
              "td",
              {},
              h(
                "span",
                { class: late ? "status late" : "status" },
                late
                  ? `${t.delay} min late`
                  : t.delay > 0
                    ? `on time (+${t.delay} min)`
                    : "on time",
              ),
            ),
          );
        }),
      ),
    ),
  );
}

// ---- state, filters, loading ----

const state = { days: "30", category: "all" };

function syncFilters() {
  for (const [id, key] of [
    ["filter-days", "days"],
    ["filter-category", "category"],
  ]) {
    for (const button of $(id).querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.value === state[key]));
    }
  }
}

for (const [id, key] of [
  ["filter-days", "days"],
  ["filter-category", "category"],
]) {
  $(id).addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state[key] = button.dataset.value;
    syncFilters();
    loadDashboard();
  });
}

let latestRequest = 0;

async function loadDashboard() {
  // Answers can arrive out of order when filters are clicked quickly; only
  // the most recent request may render.
  const request = ++latestRequest;
  let data;
  try {
    const res = await fetch(`/api/dashboard?days=${state.days}&category=${state.category}`);
    if (!res.ok) return;
    data = await res.json();
    if (request !== latestRequest) return;
  } catch {
    return; // keep the last render; the next refresh tries again
  }
  const c = data.coverage;
  $("coverage").textContent = c.first
    ? `${int.format(c.runs)} train runs collected, ${c.first} to ${c.last}`
    : "No data yet. Run npm run backfill.";
  $("threshold-note").textContent =
    `${data.thresholds.long}+ minutes (long-distance) or ${data.thresholds.commuter}+ minutes (commuter)`;
  renderTiles(data);
  renderDaily(data);
  renderHeatmap(data);
  renderMap(data);
  renderCauses(data);
  renderWorst(data);
}

async function loadLive() {
  try {
    const res = await fetch("/api/live");
    if (res.ok) renderLive(await res.json());
  } catch {
    // the server is restarting; try again on the next interval
  }
}

syncFilters();
loadDashboard();
loadLive();
setInterval(loadLive, 30_000);
setInterval(loadDashboard, 5 * 60_000);
