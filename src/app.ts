import path from "node:path";
import { fileURLToPath } from "node:url";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import { type CategoryFilter, Repository, type Scope } from "./db.js";
import { Collector } from "./lib/collector.js";
import { Digitraffic, type Fetch } from "./lib/digitraffic.js";
import { networkEdges } from "./lib/network.js";
import { LATE_THRESHOLD_MIN } from "./lib/summarize.js";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  logLevel: string;
  /** Sent as the Digitraffic-User header. An application name, nothing personal. */
  digitrafficUser: string;
  /** Follow the live feed. Off in tests and for a read-only replica of a database. */
  collect: boolean;
  pollMs: number;
}

export function loadConfig(): Config {
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 8084),
    dbPath: process.env.DB_PATH ?? "data/peron.db",
    logLevel: process.env.LOG_LEVEL ?? "info",
    digitrafficUser: process.env.DIGITRAFFIC_USER ?? "peron-train-stats/1.0",
    collect: process.env.COLLECT !== "false",
    pollMs: Number(process.env.POLL_MS ?? 30_000),
  };
}

declare module "fastify" {
  interface FastifyInstance {
    repo: Repository;
    collector: Collector;
  }
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const DAY_MS = 86_400_000;
const CACHE_MS = 60_000;

/** My English glosses of the feed's Finnish cause categories. */
const CAUSE_LABELS: Record<string, string> = {
  A: "Timetable and operations",
  E: "Running ahead of schedule",
  H: "Staff",
  I: "Other causes",
  J: "Train formation",
  K: "Rolling stock (multiple units, coaches)",
  L: "Traffic management",
  M: "Passenger service",
  O: "Accident",
  P: "Traffic control systems",
  R: "Track works",
  S: "Electrification",
  T: "Track (infrastructure)",
  V: "Locomotives",
  X: "Reported to traffic control",
};

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
}

const DashboardQuery = Type.Object({
  days: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),
  category: Type.Union([Type.Literal("all"), Type.Literal("long"), Type.Literal("commuter")], {
    default: "all",
  }),
});

export async function buildApp(
  config: Config,
  deps: { fetch?: Fetch; now?: () => number } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
  }).withTypeProvider<TypeBoxTypeProvider>();
  const now = deps.now ?? Date.now;

  const repo = new Repository(config.dbPath);
  const api = new Digitraffic(config.digitrafficUser, deps.fetch);
  const collector = new Collector(api, repo, (m) => app.log.warn(m));
  app.decorate("repo", repo);
  app.decorate("collector", collector);
  app.addHook("onClose", async () => {
    collector.stop();
    repo.close();
  });

  await app.register(rateLimit, { global: true, max: 300, timeWindow: 60_000 });
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/static/" });
  app.get("/", (_request, reply) => reply.sendFile("index.html"));
  app.get("/map", (_request, reply) => reply.sendFile("map.html"));

  app.get("/healthz", async () => ({
    status: "ok",
    collecting: config.collect,
    lastPollAt: collector.state.lastPollAt,
    lastError: collector.state.lastError,
  }));

  // The aggregates only change as fast as trains finish; a minute of caching
  // makes the page cost one set of queries per filter combination.
  const cache = new Map<string, { at: number; body: unknown }>();

  app.get("/api/dashboard", { schema: { querystring: DashboardQuery } }, async (request) => {
    const { days, category } = request.query;
    const key = `${days}:${category}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.body;

    // "Last N days" includes today, by departure date in UTC.
    const since = new Date(now() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    const scope: Scope = { since, category: category as CategoryFilter };

    const names = repo.stationNames();
    const totals = repo.totals(scope);
    const delays = repo.finalDelays(scope);
    const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

    const body = {
      scope: { days, category, since },
      thresholds: LATE_THRESHOLD_MIN,
      coverage: repo.coverage(),
      totals: {
        runs: totals.runs,
        measured: totals.measured,
        onTime: share(totals.measured - totals.late, totals.measured),
        cancelled: share(totals.cancelled, totals.runs),
        meanDelay: totals.meanDelay,
        medianDelay: percentile(delays, 0.5),
        p90Delay: percentile(delays, 0.9),
      },
      daily: repo.daily(since),
      heatmap: repo.heatmap(scope),
      causes: {
        lateRuns: totals.late,
        lateRunsWithCause: repo.lateRunsWithCause(scope),
        byCategory: repo.causes(scope).map((c) => ({
          ...c,
          label: CAUSE_LABELS[c.code] ?? c.nameFi,
        })),
      },
      worstTrains: repo.worstTrains(scope, Math.max(3, Math.floor(days / 3)), 12).map((t) => ({
        ...t,
        origin: names.get(t.origin) ?? t.origin,
        destination: names.get(t.destination) ?? t.destination,
      })),
      stations: repo.stationStats(scope, Math.max(20, days * 4)),
    };
    cache.set(key, { at: now(), body });
    return body;
  });

  /**
   * Stations and the lines between them. Built once from a full day of
   * traffic and kept in the database: the network changes over years.
   */
  app.get("/api/network", async (_request, reply) => {
    let edges = repo.getMeta("network_edges");
    if (edges === null) {
      if (repo.stationCount() === 0) await collector.loadMetadata();
      // Yesterday is the most recent day with a complete timetable.
      const day = new Date(now() - DAY_MS).toISOString().slice(0, 10);
      edges = JSON.stringify(networkEdges(await api.trainsOn(day)));
      repo.setMeta("network_edges", edges);
    }
    reply.header("cache-control", "public, max-age=3600");
    return { stations: repo.allStations(), edges: JSON.parse(edges) as [string, string][] };
  });

  // Every open map polls this; one upstream request serves them all.
  const POSITIONS_TTL_MS = 10_000;
  let positions: { at: number; body: unknown } | null = null;

  app.get("/api/positions", async () => {
    if (positions && now() - positions.at < POSITIONS_TTL_MS) return positions.body;
    const locations = await api.trainLocations();
    const body = {
      at: now(),
      thresholds: LATE_THRESHOLD_MIN,
      trains: locations.map((loc) => {
        // Freight and service trains report positions too but are not in the
        // statistics; they are shown without details.
        const info = repo.runInfo(loc.date, loc.number);
        return {
          id: `${loc.date}/${loc.number}`,
          number: loc.number,
          lon: loc.lon,
          lat: loc.lat,
          speed: loc.speed,
          seenAt: loc.at,
          category: info?.category ?? null,
          name: info ? `${info.line ?? info.type} ${loc.number}` : `Train ${loc.number}`,
          origin: info?.origin ?? null,
          destination: info?.destination ?? null,
          delay: info?.delay ?? null,
        };
      }),
    };
    positions = { at: now(), body };
    return body;
  });

  const replays = new Map<string, unknown>();

  /** Yesterday's traffic, for the time-lapse. A finished day never changes, so it is built once. */
  app.get("/api/replay", async () => {
    const date = new Date(now() - DAY_MS).toISOString().slice(0, 10);
    let body = replays.get(date);
    if (!body) {
      body = { date, thresholds: LATE_THRESHOLD_MIN, runs: repo.replay(date) };
      replays.clear();
      replays.set(date, body);
    }
    return body;
  });

  app.get("/api/live", async () => ({
    at: now(),
    lastPollAt: collector.state.lastPollAt,
    running: repo.runningCount(),
    thresholds: LATE_THRESHOLD_MIN,
    trains: repo.live(15),
  }));

  return app;
}
