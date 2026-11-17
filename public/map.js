const $ = (id) => document.getElementById(id);

const POLL_MS = 10_000;
const VERY_LATE_MIN = 15;
const COLORS = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b", other: "#9aa0ab" };
const CITY_LABELS = [
  "HKI",
  "TPE",
  "TKU",
  "OL",
  "ROI",
  "KUO",
  "JNS",
  "VS",
  "JY",
  "LH",
  "KV",
  "SK",
  "KAJ",
  "KOK",
  "KEM",
  "PRI",
];
const VIEWS = {
  finland: null, // fitted to the whole network once it has loaded
  helsinki: { west: 24.25, east: 25.55, south: 60.08, north: 60.72 },
};

/** How long a dot takes to glide to its newest position: one poll live, one step in a replay. */
let stepMs = POLL_MS;
/** Set while the time-lapse is playing: { data, time, timer }. */
let replay = null;

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const layers = { base: $("base"), trails: $("trails"), trains: $("trains") };
const ctx = Object.fromEntries(Object.entries(layers).map(([k, c]) => [k, c.getContext("2d")]));

let width = 0;
let height = 0;
let network = null;
let view = null; // the bounds currently drawn
let viewAnim = null; // { from, to, start }
let thresholds = { long: 5, commuter: 3 };
/** id -> { from, to, movedAt, bornAt, goneAt, info } */
const trains = new Map();

// ---- projection ----

function project(lon, lat) {
  // Equirectangular, with longitude squeezed for the latitude in view; the
  // bounds are fitted into the window with room left for the panels.
  const squeeze = Math.cos((((view.south + view.north) / 2) * Math.PI) / 180);
  const spanX = (view.east - view.west) * squeeze;
  const spanY = view.north - view.south;
  const pad = Math.min(width, height) * 0.07;
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const x0 = (width - spanX * scale) / 2;
  const y0 = (height - spanY * scale) / 2;
  return [x0 + (lon - view.west) * squeeze * scale, y0 + (view.north - lat) * scale];
}

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// ---- base layer: lines, stations, city names ----

function drawBase() {
  const c = ctx.base;
  c.clearRect(0, 0, width, height);
  if (!network || !view) return;

  c.lineWidth = 1;
  c.strokeStyle = "rgba(150, 185, 255, 0.34)";
  c.beginPath();
  for (const [a, b] of network.edges) {
    const from = network.byCode.get(a);
    const to = network.byCode.get(b);
    if (!from || !to) continue;
    const [x1, y1] = project(from.lon, from.lat);
    const [x2, y2] = project(to.lon, to.lat);
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
  }
  c.stroke();

  c.fillStyle = "rgba(210, 225, 255, 0.6)";
  for (const station of network.stations) {
    if (!station.passenger) continue;
    const [x, y] = project(station.lon, station.lat);
    c.beginPath();
    c.arc(x, y, 1.3, 0, Math.PI * 2);
    c.fill();
  }

  c.font = "12px system-ui, sans-serif";
  c.fillStyle = "rgba(240, 239, 236, 0.6)";
  c.textBaseline = "middle";
  for (const code of CITY_LABELS) {
    const station = network.byCode.get(code);
    if (!station) continue;
    const [x, y] = project(station.lon, station.lat);
    if (x < 0 || x > width || y < 0 || y > height) continue;
    c.fillText(station.name, x + 8, y);
  }
}

// ---- trains ----

function colorOf(info) {
  if (info.category === null) return COLORS.other;
  if (info.delay === null || info.delay < thresholds[info.category]) return COLORS.good;
  return info.delay >= VERY_LATE_MIN ? COLORS.critical : COLORS.warning;
}

function statusText(info) {
  if (info.category === null) return "Freight or service train";
  if (info.delay === null) return "No delay reported yet";
  if (info.delay < thresholds[info.category])
    return info.delay > 0 ? `On time (+${info.delay} min)` : "On time";
  return `${info.delay} min late`;
}

/** Where a train is drawn right now: gliding from its last reported point to the newest. */
function positionOf(train, now) {
  if (reducedMotion) return train.to;
  const t = Math.min(1, (now - train.movedAt) / stepMs);
  return { lon: lerp(train.from.lon, train.to.lon, t), lat: lerp(train.from.lat, train.to.lat, t) };
}

function applyPositions(data) {
  const now = performance.now();
  thresholds = data.thresholds;
  const seen = new Set();
  for (const info of data.trains) {
    seen.add(info.id);
    const next = { lon: info.lon, lat: info.lat };
    const existing = trains.get(info.id);
    if (existing) {
      existing.from = positionOf(existing, now);
      existing.to = next;
      existing.movedAt = now;
      existing.goneAt = null;
      existing.info = info;
    } else {
      trains.set(info.id, { from: next, to: next, movedAt: now, bornAt: now, goneAt: null, info });
    }
  }
  for (const [id, train] of trains) {
    if (!seen.has(id) && train.goneAt === null) train.goneAt = now;
  }
  renderHud(data.trains);
}

function drawFrame(now) {
  if (viewAnim) {
    const t = Math.min(1, (now - viewAnim.start) / 900);
    const k = ease(t);
    view = Object.fromEntries(
      ["west", "east", "south", "north"].map((key) => [
        key,
        lerp(viewAnim.from[key], viewAnim.to[key], k),
      ]),
    );
    if (t === 1) viewAnim = null;
    drawBase();
    ctx.trails.clearRect(0, 0, width, height); // old trails belong to the old view
  }

  const c = ctx.trains;
  const trail = ctx.trails;
  c.clearRect(0, 0, width, height);
  if (view) {
    // Fade the trail layer a little each frame; what a train leaves behind
    // lingers for a couple of seconds.
    if (!reducedMotion) {
      trail.globalCompositeOperation = "destination-out";
      trail.fillStyle = "rgba(0, 0, 0, 0.035)";
      trail.fillRect(0, 0, width, height);
      trail.globalCompositeOperation = "source-over";
    }

    for (const [id, train] of trains) {
      const fadeIn = Math.min(1, (now - train.bornAt) / 800);
      const fadeOut = train.goneAt === null ? 1 : 1 - (now - train.goneAt) / 1500;
      if (fadeOut <= 0) {
        trains.delete(id);
        continue;
      }
      const pos = positionOf(train, now);
      const [x, y] = project(pos.lon, pos.lat);
      train.x = x;
      train.y = y;
      if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;

      const color = colorOf(train.info);
      const passenger = train.info.category !== null;
      const radius = train.info.category === "long" ? 4 : passenger ? 3 : 2.6;
      const alpha = fadeIn * fadeOut * (passenger ? 1 : 0.85);

      if (!reducedMotion && !viewAnim && passenger) {
        trail.globalAlpha = 0.5 * alpha;
        trail.fillStyle = color;
        trail.beginPath();
        trail.arc(x, y, radius * 0.6, 0, Math.PI * 2);
        trail.fill();
        trail.globalAlpha = 1;
      }

      // A very late train sends out a slow ring, so it is findable at a glance.
      if (!reducedMotion && color === COLORS.critical) {
        const phase = ((now + train.info.number * 137) % 2200) / 2200;
        c.globalAlpha = alpha * (1 - phase) * 0.7;
        c.strokeStyle = color;
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(x, y, radius + phase * 16, 0, Math.PI * 2);
        c.stroke();
      }

      c.globalAlpha = alpha;
      c.shadowColor = color;
      c.shadowBlur = passenger ? 16 : 6;
      c.fillStyle = color;
      c.beginPath();
      c.arc(x, y, radius, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
      // A bright core makes the dot read as a light, not a flat disc.
      c.fillStyle = `rgba(255, 255, 255, ${passenger ? 0.85 : 0.4})`;
      c.beginPath();
      c.arc(x, y, radius * 0.4, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }
  requestAnimationFrame(drawFrame);
}

// ---- HUD ----

const clockFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Helsinki",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function renderHud(list) {
  const passenger = list.filter((t) => t.category !== null && t.delay !== null);
  const onTime = passenger.filter((t) => t.delay < thresholds[t.category]).length;
  const worst = passenger.reduce((max, t) => (max === null || t.delay > max.delay ? t : max), null);
  $("stat-count").textContent = String(list.length);
  $("stat-ontime").textContent =
    passenger.length === 0 ? "–" : `${Math.round((onTime / passenger.length) * 100)}%`;
  $("stat-worst").textContent =
    worst && worst.delay > 0 ? `${worst.name} · ${worst.delay} min` : "none";
}

setInterval(() => {
  $("clock").textContent = replay
    ? `Replay · ${clockFmt.format(replay.time)} · ${replay.data.date}`
    : `${clockFmt.format(Date.now())} in Helsinki`;
}, 1000);

// ---- tooltip: nearest train to the pointer ----

layers.trains.addEventListener("pointermove", (event) => {
  let nearest = null;
  let best = 18 ** 2;
  for (const train of trains.values()) {
    if (train.x === undefined) continue;
    const d = (train.x - event.clientX) ** 2 + (train.y - event.clientY) ** 2;
    if (d < best) {
      best = d;
      nearest = train;
    }
  }
  const tooltip = $("tooltip");
  if (!nearest) {
    tooltip.hidden = true;
    return;
  }
  const info = nearest.info;
  const title = document.createElement("strong");
  title.textContent = info.name;
  const lines = [
    info.origin && info.destination ? `${info.origin} → ${info.destination}` : null,
    statusText(info),
    info.speed === null ? null : `${info.speed} km/h`,
  ].filter(Boolean);
  tooltip.replaceChildren(
    title,
    ...lines.flatMap((line) => [line, document.createElement("br")]).slice(0, -1),
  );
  tooltip.hidden = false;
  const box = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.min(event.clientX + 14, width - box.width - 8)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY - box.height - 12)}px`;
});
layers.trains.addEventListener("pointerleave", () => {
  $("tooltip").hidden = true;
});

// ---- view switching ----

for (const button of document.querySelectorAll("#controls button[data-view]")) {
  button.addEventListener("click", () => {
    const target = VIEWS[button.dataset.view];
    if (!target || !view) return;
    for (const other of document.querySelectorAll("#controls button[data-view]")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    if (reducedMotion) {
      view = { ...target };
      drawBase();
      ctx.trails.clearRect(0, 0, width, height);
    } else {
      viewAnim = { from: { ...view }, to: target, start: performance.now() };
    }
  });
}

// ---- sizing and loading ----

function resize() {
  const dpr = window.devicePixelRatio || 1;
  width = window.innerWidth;
  height = window.innerHeight;
  for (const [key, canvas] of Object.entries(layers)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx[key].setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  drawBase();
}
window.addEventListener("resize", resize);

async function loadNetwork() {
  const data = await fetch("/api/network").then((res) => res.json());
  const byCode = new Map(data.stations.map((station) => [station.code, station]));
  // Fit to stations that are actually on a line; the list also holds a few far-off border points.
  const used = [...new Set(data.edges.flat())].map((code) => byCode.get(code)).filter(Boolean);
  VIEWS.finland = {
    west: Math.min(...used.map((s) => s.lon)),
    east: Math.max(...used.map((s) => s.lon)),
    south: Math.min(...used.map((s) => s.lat)),
    north: Math.max(...used.map((s) => s.lat)),
  };
  network = { ...data, byCode };
  view = { ...VIEWS.finland };
  drawBase();
}

async function poll() {
  if (replay) return;
  try {
    const res = await fetch("/api/positions");
    if (res.ok) applyPositions(await res.json());
  } catch {
    // keep the last known positions; the next poll tries again
  }
}

// ---- replay: yesterday as a time-lapse ----

const REPLAY_STEP_MS = 200; // real time between frames of the replay
const REPLAY_SPEED = 600; // ten minutes of traffic per second

/** Where every run was at a given moment, in the shape the live feed has. */
function replayPositions(data, time) {
  const out = [];
  for (const run of data.runs) {
    const points = run.points;
    if (time < points[0][2] || time > points[points.length - 1][2]) continue;
    // Runs are replayed forwards, so the search resumes where it last stopped.
    let i = run.cursor !== undefined && points[run.cursor][2] <= time ? run.cursor : 0;
    while (i < points.length - 2 && points[i + 1][2] <= time) i++;
    run.cursor = i;
    const [lon1, lat1, t1] = points[i];
    const [lon2, lat2, t2, delay] = points[i + 1];
    const k = t2 === t1 ? 1 : (time - t1) / (t2 - t1);
    out.push({
      id: `replay/${run.number}`,
      number: run.number,
      name: run.name,
      category: run.category,
      origin: run.origin,
      destination: run.destination,
      lon: lerp(lon1, lon2, k),
      lat: lerp(lat1, lat2, k),
      delay,
      speed: null,
    });
  }
  return out;
}

async function startReplay() {
  const data = await fetch("/api/replay").then((res) => res.json());
  if (data.runs.length === 0) return false;
  const start = Math.min(...data.runs.map((run) => run.points[0][2]));
  const end = Math.max(...data.runs.map((run) => run.points[run.points.length - 1][2]));
  trains.clear();
  ctx.trails.clearRect(0, 0, width, height);
  stepMs = REPLAY_STEP_MS;
  // Skip the empty small hours: begin at 05:00 Finnish winter time, when the first trains leave.
  const begin = Math.max(start, Date.parse(`${data.date}T03:00:00Z`));
  replay = { data, time: begin, timer: null };
  const step = () => {
    replay.time += REPLAY_STEP_MS * REPLAY_SPEED;
    if (replay.time > end) replay.time = begin; // loop
    applyPositions({ thresholds: data.thresholds, trains: replayPositions(data, replay.time) });
  };
  step();
  replay.timer = setInterval(step, REPLAY_STEP_MS);
  return true;
}

function stopReplay() {
  clearInterval(replay.timer);
  replay = null;
  stepMs = POLL_MS;
  trains.clear();
  ctx.trails.clearRect(0, 0, width, height);
  poll();
}

$("replay-toggle").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (replay) {
    stopReplay();
  } else if (!(await startReplay())) {
    button.textContent = "No replay data";
    return;
  }
  button.setAttribute("aria-pressed", String(replay !== null));
  button.textContent = replay ? "Back to live" : "Replay yesterday";
  $("stat-count-label").textContent = replay ? "Trains running" : "Trains reporting";
  $("mode").textContent = replay ? "replay" : "live";
});

resize();
requestAnimationFrame(drawFrame);
await loadNetwork();
await poll();
setInterval(poll, POLL_MS);
// Expose a little state for debugging from the console.
window.peron = { trains, views: VIEWS, network: () => network };
