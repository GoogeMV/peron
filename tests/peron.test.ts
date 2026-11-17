import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type Config, percentile } from "../src/app.js";
import { Repository } from "../src/db.js";
import { Collector } from "../src/lib/collector.js";
import { Digitraffic, type Fetch } from "../src/lib/digitraffic.js";
import { networkEdges } from "../src/lib/network.js";
import {
  helsinkiTime,
  type RawRow,
  type RawTrain,
  summarize,
  type TrainSummary,
} from "../src/lib/summarize.js";

/** Four real trains from the feed for 2026-11-16: IC 148, commuter 1604, a cancelled commuter, a cargo train. */
const fixture: RawTrain[] = JSON.parse(
  fs.readFileSync(new URL("./fixtures/trains.json", import.meta.url), "utf8"),
);
const byNumber = (n: number) => fixture.find((t) => t.trainNumber === n) as RawTrain;

function row(
  type: RawRow["type"],
  station: string,
  scheduled: string,
  diff: number | null,
  extra: Partial<RawRow> = {},
): RawRow {
  return {
    type,
    stationShortCode: station,
    scheduledTime: scheduled,
    commercialStop: true,
    cancelled: false,
    causes: [],
    ...(diff !== null && { actualTime: scheduled, differenceInMinutes: diff }),
    ...extra,
  };
}

/** A two-stop run HKI -> TPE with the given delay at the final stop. */
function run(
  number: number,
  date: string,
  finalDelay: number | null,
  extra: Partial<RawTrain> = {},
) {
  return {
    trainNumber: number,
    departureDate: date,
    trainCategory: "Long-distance",
    trainType: "IC",
    operatorShortCode: "vr",
    cancelled: false,
    runningCurrently: false,
    version: 1,
    timeTableRows: [
      row("DEPARTURE", "HKI", `${date}T08:00:00.000Z`, 0),
      row("ARRIVAL", "TPE", `${date}T09:30:00.000Z`, finalDelay),
    ],
    ...extra,
  } satisfies RawTrain;
}

const sum = (raw: RawTrain) => summarize(raw) as TrainSummary;

describe("summarize", () => {
  it("reduces a real long-distance train to its commercial stops", () => {
    const train = sum(byNumber(148));
    expect(train).toMatchObject({
      date: "2026-11-16",
      number: 148,
      category: "long",
      type: "IC",
      line: null,
      origin: "PM",
      destination: "TPE",
      hour: 18, // 16:10 UTC is 18:10 in Helsinki in November
      dow: 0, // a Monday
      cancelled: false,
      finalDelay: 2,
      late: false,
      causes: ["L"],
    });
    // 38 timetable rows, most of them junctions passed without stopping.
    expect(byNumber(148).timeTableRows).toHaveLength(38);
    expect(train.stops).toHaveLength(5);
    expect(train.stops.at(-1)).toMatchObject({ station: "TPE", delay: 2, late: false });
  });

  it("keeps the commuter line letter and applies the commuter threshold", () => {
    expect(sum(byNumber(1604))).toMatchObject({
      category: "commuter",
      line: "H",
      hour: 6,
      finalDelay: 0,
      late: false,
    });
    const commuter = { trainCategory: "Commuter", trainType: "HL" };
    expect(sum(run(1, "2026-11-10", 3, commuter)).late).toBe(true);
    expect(sum(run(1, "2026-11-10", 3)).late).toBe(false); // 3 min is fine for long-distance
    expect(sum(run(1, "2026-11-10", 5)).late).toBe(true);
  });

  it("gives a cancelled train no delay, so it cannot count as punctual", () => {
    expect(sum(byNumber(10146))).toMatchObject({ cancelled: true, finalDelay: null, late: null });
  });

  it("ignores non-passenger traffic", () => {
    expect(byNumber(2003).trainCategory).toBe("Cargo");
    expect(summarize(byNumber(2003))).toBeNull();
  });

  it("reports where a running train was last measured", () => {
    const train = sum({
      ...run(7, "2026-11-10", null, { runningCurrently: true }),
      timeTableRows: [
        row("DEPARTURE", "HKI", "2026-11-10T08:00:00.000Z", 1),
        row("ARRIVAL", "RI", "2026-11-10T08:40:00.000Z", 9),
        row("DEPARTURE", "RI", "2026-11-10T08:42:00.000Z", 11),
        row("ARRIVAL", "TPE", "2026-11-10T09:30:00.000Z", null),
      ],
    });
    expect(train).toMatchObject({
      running: true,
      finalDelay: null,
      late: null,
      maxDelay: 9,
      currentDelay: 11,
      lastStation: "RI",
    });
  });

  it("is deterministic, which is what makes re-ingesting safe", () => {
    expect(summarize(byNumber(148))).toEqual(summarize(byNumber(148)));
  });

  it("uses Finnish local time across the daylight-saving change", () => {
    expect(helsinkiTime(Date.parse("2026-01-15T22:30:00Z"))).toEqual({ hour: 0, dow: 4 }); // UTC+2, already Friday
    expect(helsinkiTime(Date.parse("2026-07-15T22:30:00Z"))).toEqual({ hour: 1, dow: 3 }); // UTC+3, Thursday
  });
});

describe("Repository", () => {
  const seeded = () => {
    const repo = new Repository(":memory:");
    repo.replaceStations([
      { code: "HKI", name: "Helsinki", lat: 60.17, lon: 24.94, passenger: true },
      { code: "TPE", name: "Tampere", lat: 61.5, lon: 23.77, passenger: true },
    ]);
    repo.replaceCauseCategories([{ code: "K", nameFi: "Kalusto" }]);
    const withCause = (raw: RawTrain): RawTrain => ({
      ...raw,
      timeTableRows: raw.timeTableRows.map((r, i) =>
        i === 1 ? { ...r, causes: [{ categoryCode: "K" }] } : r,
      ),
    });
    repo.upsertTrains(
      [
        run(1, "2026-11-10", 0),
        run(1, "2026-11-11", 12),
        run(1, "2026-11-12", 7),
        run(2, "2026-11-10", -2),
        run(2, "2026-11-11", 1),
        run(2, "2026-11-12", 4),
        withCause(run(3, "2026-11-10", 30)),
        run(4, "2026-11-10", null, { cancelled: true }),
        run(5, "2026-11-10", 3, {
          trainCategory: "Commuter",
          trainType: "HL",
          commuterLineID: "A",
        }),
      ].map(sum),
    );
    return repo;
  };

  it("computes punctuality over completed runs and reports cancellations separately", () => {
    const repo = seeded();
    const all = repo.totals({ since: "2026-11-10", category: "all" });
    expect(all).toMatchObject({ runs: 9, measured: 8, late: 4, cancelled: 1 });
    // Early arrivals count as zero, not as negative delay.
    expect(all.meanDelay).toBeCloseTo((0 + 12 + 7 + 0 + 1 + 4 + 30 + 3) / 8);

    expect(repo.totals({ since: "2026-11-10", category: "commuter" })).toMatchObject({
      runs: 1,
      late: 1,
    });
    expect(repo.totals({ since: "2026-11-12", category: "all" })).toMatchObject({
      runs: 2,
      late: 1,
    });
    expect(repo.finalDelays({ since: "2026-11-10", category: "long" })).toEqual([
      0, 0, 1, 4, 7, 12, 30,
    ]);
    repo.close();
  });

  it("ranks trains by late share and attributes causes to late runs", () => {
    const repo = seeded();
    const scope = { since: "2026-11-10", category: "all" as const };
    expect(repo.worstTrains(scope, 3, 10)).toMatchObject([
      { number: 1, measured: 3, late: 2, worstDelay: 12 },
      { number: 2, measured: 3, late: 0 },
    ]);
    expect(repo.causes(scope)).toEqual([{ code: "K", nameFi: "Kalusto", lateRuns: 1 }]);
    expect(repo.lateRunsWithCause(scope)).toBe(1);
    expect(repo.stationStats(scope, 1)).toMatchObject([
      { code: "TPE", name: "Tampere", measured: 8, late: 4 },
    ]);
    expect(repo.daily("2026-11-10")[0]).toEqual({
      date: "2026-11-10",
      category: "commuter",
      measured: 1,
      late: 1,
    });
    repo.close();
  });

  it("orders the ranking by late share, whichever run happens to come first", () => {
    const repo = new Repository(":memory:");
    const runs = (n: number, delays: number[]) =>
      delays.map((delay, i) => sum(run(n, `2026-11-1${i}`, delay)));
    repo.upsertTrains([...runs(1, [6, 0, 0]), ...runs(2, [0, 6, 6]), ...runs(3, [0, 0, 0])]);
    const ranked = repo.worstTrains({ since: "2026-11-10", category: "all" }, 3, 10);
    expect(ranked.map((t) => [t.number, t.late])).toEqual([
      [2, 2],
      [1, 1],
      [3, 0],
    ]);
    repo.close();
  });

  it("re-ingesting a run replaces it instead of duplicating it", () => {
    const repo = seeded();
    const before = repo.totals({ since: "2026-11-10", category: "all" });
    repo.upsertTrains([sum(run(1, "2026-11-11", 12)), sum(run(1, "2026-11-11", 12))]);
    expect(repo.totals({ since: "2026-11-10", category: "all" })).toEqual(before);
    expect(repo.stationStats({ since: "2026-11-10", category: "all" }, 1)[0]?.measured).toBe(8);
    repo.close();
  });

  it("never lets an older version of a run overwrite a newer one", () => {
    const repo = new Repository(":memory:");
    repo.upsertTrains([sum(run(1, "2026-11-10", 20, { version: 50 }))]);
    expect(repo.upsertTrains([sum(run(1, "2026-11-10", 0, { version: 40 }))])).toBe(0);
    expect(repo.finalDelays({ since: "2026-11-10", category: "all" })).toEqual([20]);
    expect(repo.upsertTrains([sum(run(1, "2026-11-10", 3, { version: 60 }))])).toBe(1);
    expect(repo.finalDelays({ since: "2026-11-10", category: "all" })).toEqual([3]);
    repo.close();
  });
});

describe("percentile", () => {
  it("reads from a sorted list and has no answer for an empty one", () => {
    const sorted = [0, 0, 1, 2, 3, 5, 8, 13, 21, 34];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.9)).toBe(34);
    expect(percentile([], 0.5)).toBeNull();
  });
});

function fakeFeed(responses: Record<string, unknown>): {
  fetch: Fetch;
  calls: string[];
  headers: Headers[];
} {
  const calls: string[] = [];
  const headers: Headers[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const path = String(input).replace("https://rata.digitraffic.fi/api/v1", "");
    calls.push(path);
    headers.push(new Headers(init?.headers));
    const key = Object.keys(responses).find((prefix) => path.startsWith(prefix));
    if (!key) return new Response("nope", { status: 500 });
    return Response.json(responses[key]);
  };
  return { fetch: fetchImpl, calls, headers };
}

describe("Collector", () => {
  it("ingests what changed, skips freight, and resumes from the stored cursor", async () => {
    const repo = new Repository(":memory:");
    const feed = fakeFeed({ "/live-trains": fixture });
    const collector = new Collector(new Digitraffic("peron-test", feed.fetch), repo);

    expect(await collector.tick(1000)).toBe(3); // the cargo train is not stored
    const highest = Math.max(...fixture.map((t) => t.version));
    expect(collector.state).toMatchObject({ cursor: highest, lastPollAt: 1000, lastError: null });
    expect(feed.calls).toEqual(["/live-trains?version=0"]);
    expect(feed.headers[0]?.get("digitraffic-user")).toBe("peron-test");

    // A new process picks the cursor up from the database.
    const restarted = new Collector(new Digitraffic("peron-test", feed.fetch), repo);
    await restarted.tick(2000);
    expect(feed.calls[1]).toBe(`/live-trains?version=${highest}`);
    expect(repo.coverage().runs).toBe(3);
    repo.close();
  });

  it("leaves the cursor alone when the feed fails, so nothing is skipped", async () => {
    const repo = new Repository(":memory:");
    const collector = new Collector(new Digitraffic("peron-test", fakeFeed({}).fetch), repo);
    await expect(collector.tick()).rejects.toThrow("answered 500");
    expect(collector.state.cursor).toBe(0);
    expect(repo.getMeta("live_version")).toBeNull();
    repo.close();
  });

  it("takes trains that stopped reporting off the live board", async () => {
    const repo = new Repository(":memory:");
    repo.upsertTrains([sum(run(9, "2026-11-10", null, { runningCurrently: true }))]);
    expect(repo.runningCount()).toBe(1);
    const collector = new Collector(
      new Digitraffic("t", fakeFeed({ "/live-trains": [] }).fetch),
      repo,
    );
    await collector.tick(Date.parse("2026-11-12T12:00:00Z"));
    expect(repo.runningCount()).toBe(0);
    repo.close();
  });
});

describe("networkEdges", () => {
  it("joins consecutive timetable points into undirected, de-duplicated lines", () => {
    const there = run(1, "2026-11-10", 0);
    const back = {
      ...run(2, "2026-11-10", 0),
      timeTableRows: [
        row("DEPARTURE", "TPE", "2026-11-10T10:00:00.000Z", 0),
        row("ARRIVAL", "RI", "2026-11-10T10:50:00.000Z", 0),
        row("DEPARTURE", "RI", "2026-11-10T10:52:00.000Z", 0), // same station twice: not an edge
        row("ARRIVAL", "HKI", "2026-11-10T11:30:00.000Z", 0),
      ],
    };
    expect(networkEdges([there, back, there])).toEqual([
      ["HKI", "RI"],
      ["HKI", "TPE"],
      ["RI", "TPE"],
    ]);
  });

  it("traces junctions a real train only passes through", () => {
    const edges = networkEdges([byNumber(148)]);
    // 38 rows over far more points than its 6 commercial stops.
    expect(edges.length).toBeGreaterThan(10);
    expect(new Set(edges.flat()).has("TPE")).toBe(true);
  });
});

describe("HTTP API", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    logLevel: "silent",
    digitrafficUser: "peron-test",
    collect: false,
    pollMs: 30_000,
  };

  it("serves the dashboard for a period ending today, cached for a minute", async () => {
    let now = Date.parse("2026-11-12T12:00:00Z");
    app = await buildApp(config, { now: () => now });
    app.repo.upsertTrains(
      [run(1, "2026-11-12", 9), run(2, "2026-11-12", 0), run(3, "2026-11-01", 0)].map(sum),
    );

    const get = async (url: string) =>
      (await (app as FastifyInstance).inject({ method: "GET", url })).json();
    const week = await get("/api/dashboard?days=7");
    expect(week.scope).toEqual({ days: 7, category: "all", since: "2026-11-06" });
    expect(week.totals).toMatchObject({
      runs: 2,
      measured: 2,
      onTime: 0.5,
      cancelled: 0,
      medianDelay: 9,
    });
    expect(week.thresholds).toEqual({ long: 5, commuter: 3 });

    app.repo.upsertTrains([sum(run(4, "2026-11-12", 0))]);
    expect((await get("/api/dashboard?days=7")).totals.runs).toBe(2); // still cached
    now += 61_000;
    expect((await get("/api/dashboard?days=7")).totals.runs).toBe(3);
    expect((await get("/api/dashboard?days=30")).totals.runs).toBe(4);
  });

  it("serves live positions with run details, one upstream call for many viewers", async () => {
    const feed = fakeFeed({
      "/train-locations/latest": [
        {
          trainNumber: 12,
          departureDate: "2026-11-12",
          timestamp: "2026-11-12T08:30:00.000Z",
          speed: 140,
          location: { coordinates: [24.5, 60.9] },
        },
        {
          trainNumber: 5555,
          departureDate: "2026-11-12",
          timestamp: "2026-11-12T08:30:00.000Z",
          speed: 60,
          location: { coordinates: [25.1, 61.2] },
        },
      ],
      "/trains/": [run(1, "2026-11-11", 0)],
      "/metadata/stations": [
        {
          stationShortCode: "HKI",
          stationName: "Helsinki asema",
          latitude: 60.17,
          longitude: 24.94,
          passengerTraffic: true,
        },
        {
          stationShortCode: "TPE",
          stationName: "Tampere asema",
          latitude: 61.5,
          longitude: 23.77,
          passengerTraffic: true,
        },
      ],
      "/metadata/cause-category-codes": [],
    });
    let now = Date.parse("2026-11-12T08:30:05Z");
    app = await buildApp(config, { fetch: feed.fetch, now: () => now });
    const get = async (url: string) =>
      (await (app as FastifyInstance).inject({ method: "GET", url })).json();

    // The network is built on first request (stations + yesterday's trains), then stored.
    const network = await get("/api/network");
    expect(network.edges).toEqual([["HKI", "TPE"]]);
    expect(network.stations).toContainEqual({
      code: "HKI",
      name: "Helsinki",
      lat: 60.17,
      lon: 24.94,
      passenger: true,
    });
    await get("/api/network");
    expect(feed.calls.filter((c) => c.startsWith("/trains/"))).toEqual(["/trains/2026-11-11"]);

    app.repo.upsertTrains([
      sum({
        ...run(12, "2026-11-12", null, { runningCurrently: true }),
        timeTableRows: [
          row("DEPARTURE", "HKI", "2026-11-12T08:00:00.000Z", 14),
          row("ARRIVAL", "TPE", "2026-11-12T09:30:00.000Z", null),
        ],
      }),
    ]);
    const positions = await get("/api/positions");
    expect(positions.trains).toMatchObject([
      {
        number: 12,
        name: "IC 12",
        category: "long",
        delay: 14,
        origin: "Helsinki",
        destination: "Tampere",
        lon: 24.5,
        lat: 60.9,
        speed: 140,
      },
      { number: 5555, name: "Train 5555", category: null, delay: null },
    ]);

    await get("/api/positions");
    const upstream = () => feed.calls.filter((c) => c.startsWith("/train-locations")).length;
    expect(upstream()).toBe(1);
    now += 11_000;
    await get("/api/positions");
    expect(upstream()).toBe(2);
  });

  it("replays yesterday as timed points that never run backwards", async () => {
    app = await buildApp(config, { now: () => Date.parse("2026-11-12T12:00:00Z") });
    app.repo.replaceStations([
      { code: "HKI", name: "Helsinki", lat: 60.17, lon: 24.94, passenger: true },
      { code: "RI", name: "Riihimäki", lat: 60.74, lon: 24.78, passenger: true },
      { code: "TPE", name: "Tampere", lat: 61.5, lon: 23.77, passenger: true },
    ]);
    app.repo.upsertTrains([
      sum({
        ...run(7, "2026-11-11", 0),
        timeTableRows: [
          row("DEPARTURE", "HKI", "2026-11-11T08:00:00.000Z", 0),
          row("ARRIVAL", "RI", "2026-11-11T08:40:00.000Z", 6),
          row("ARRIVAL", "TPE", "2026-11-11T08:44:00.000Z", -3), // early: would precede the previous point
        ],
      }),
      sum(run(8, "2026-11-11", null, { cancelled: true })),
      sum(run(9, "2026-11-12", 0)), // today is not yesterday
    ]);
    const replay = (await app.inject({ method: "GET", url: "/api/replay" })).json();
    expect(replay.date).toBe("2026-11-11");
    expect(replay.runs).toHaveLength(1);
    const dep = Date.parse("2026-11-11T08:00:00Z");
    expect(replay.runs[0]).toMatchObject({
      number: 7,
      name: "IC 7",
      origin: "Helsinki",
      destination: "Tampere",
    });
    expect(replay.runs[0].points).toEqual([
      [24.94, 60.17, dep, 0],
      [24.78, 60.74, dep + 46 * 60_000, 6],
      [23.77, 61.5, dep + 46 * 60_000, -3],
    ]);
  });

  it("validates the query and serves the page, health and live board", async () => {
    app = await buildApp(config);
    for (const bad of ["days=0", "days=abc", "category=freight"]) {
      expect((await app.inject({ method: "GET", url: `/api/dashboard?${bad}` })).statusCode).toBe(
        400,
      );
    }
    app.repo.upsertTrains([
      sum({
        ...run(12, "2026-11-12", null, { runningCurrently: true }),
        timeTableRows: [
          row("DEPARTURE", "HKI", "2026-11-12T08:00:00.000Z", 14),
          row("ARRIVAL", "TPE", "2026-11-12T09:30:00.000Z", null),
        ],
      }),
    ]);
    const live = (await app.inject({ method: "GET", url: "/api/live" })).json();
    expect(live).toMatchObject({ running: 1, trains: [{ number: 12, delay: 14 }] });

    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toMatchObject({
      status: "ok",
      collecting: false,
    });
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("peron");
  });
});
