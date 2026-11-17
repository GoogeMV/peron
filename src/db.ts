import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Category, TrainSummary } from "./lib/summarize.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stations (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  passenger INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cause_categories (
  code TEXT PRIMARY KEY,
  name_fi TEXT NOT NULL
);

-- One row per train run (a train number on a departure date).
CREATE TABLE IF NOT EXISTS trains (
  date TEXT NOT NULL,
  number INTEGER NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  line TEXT,
  operator TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  sched_dep INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  dow INTEGER NOT NULL,
  cancelled INTEGER NOT NULL,
  running INTEGER NOT NULL,
  final_delay INTEGER,
  late INTEGER,
  max_delay INTEGER,
  current_delay INTEGER,
  last_station TEXT,
  version INTEGER NOT NULL,
  PRIMARY KEY (date, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS trains_running ON trains (running) WHERE running = 1;

CREATE TABLE IF NOT EXISTS stops (
  date TEXT NOT NULL,
  number INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  station TEXT NOT NULL,
  scheduled INTEGER NOT NULL,
  delay INTEGER,
  late INTEGER,
  cancelled INTEGER NOT NULL,
  PRIMARY KEY (date, number, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS stops_station ON stops (station, date);

CREATE TABLE IF NOT EXISTS train_causes (
  date TEXT NOT NULL,
  number INTEGER NOT NULL,
  code TEXT NOT NULL,
  PRIMARY KEY (date, number, code)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type CategoryFilter = Category | "all";

export interface Station {
  code: string;
  name: string;
  lat: number;
  lon: number;
  passenger: boolean;
}

export interface Scope {
  /** Inclusive first departure date, YYYY-MM-DD. */
  since: string;
  category: CategoryFilter;
}

const bool = (value: boolean | null): number | null => (value === null ? null : value ? 1 : 0);

export class Repository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- ingest ----

  /**
   * Stores train runs, replacing whatever was known about each. Ingest is
   * idempotent: the feed sends a full snapshot of a run every time it
   * changes, so "delete the run's rows and write them again" is always
   * correct and needs no diffing. An older version never overwrites a newer
   * one, which lets the backfill and the live collector run side by side.
   */
  upsertTrains(trains: TrainSummary[]): number {
    const current = this.db.prepare("SELECT version FROM trains WHERE date = ? AND number = ?");
    const putTrain = this.db.prepare(
      `INSERT OR REPLACE INTO trains
         (date, number, category, type, line, operator, origin, destination, sched_dep, hour, dow,
          cancelled, running, final_delay, late, max_delay, current_delay, last_station, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const clearStops = this.db.prepare("DELETE FROM stops WHERE date = ? AND number = ?");
    const clearCauses = this.db.prepare("DELETE FROM train_causes WHERE date = ? AND number = ?");
    const putStop = this.db.prepare(
      "INSERT INTO stops (date, number, seq, station, scheduled, delay, late, cancelled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const putCause = this.db.prepare(
      "INSERT INTO train_causes (date, number, code) VALUES (?, ?, ?)",
    );

    const tx = this.db.transaction((): number => {
      let written = 0;
      for (const t of trains) {
        const existing = current.get(t.date, t.number) as { version: number } | undefined;
        if (existing && existing.version > t.version) continue;

        putTrain.run(
          t.date,
          t.number,
          t.category,
          t.type,
          t.line,
          t.operator,
          t.origin,
          t.destination,
          t.scheduledDeparture,
          t.hour,
          t.dow,
          bool(t.cancelled),
          bool(t.running),
          t.finalDelay,
          bool(t.late),
          t.maxDelay,
          t.currentDelay,
          t.lastStation,
          t.version,
        );
        clearStops.run(t.date, t.number);
        clearCauses.run(t.date, t.number);
        for (const s of t.stops) {
          putStop.run(
            t.date,
            t.number,
            s.seq,
            s.station,
            s.scheduled,
            s.delay,
            bool(s.late),
            bool(s.cancelled),
          );
        }
        for (const code of t.causes) putCause.run(t.date, t.number, code);
        written++;
      }
      return written;
    });
    return tx();
  }

  /**
   * A train that stops reporting (feed gap, or it finished while the
   * collector was down) would otherwise sit on the live board forever.
   */
  expireRunning(olderThan: number): number {
    return this.db
      .prepare("UPDATE trains SET running = 0 WHERE running = 1 AND sched_dep < ?")
      .run(olderThan).changes;
  }

  replaceStations(stations: Station[]): void {
    const put = this.db.prepare(
      "INSERT OR REPLACE INTO stations (code, name, lat, lon, passenger) VALUES (?, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      for (const s of stations) put.run(s.code, s.name, s.lat, s.lon, s.passenger ? 1 : 0);
    })();
  }

  replaceCauseCategories(categories: { code: string; nameFi: string }[]): void {
    const put = this.db.prepare(
      "INSERT OR REPLACE INTO cause_categories (code, name_fi) VALUES (?, ?)",
    );
    this.db.transaction(() => {
      for (const c of categories) put.run(c.code, c.nameFi);
    })();
  }

  stationNames(): Map<string, string> {
    const rows = this.db.prepare("SELECT code, name FROM stations").all() as {
      code: string;
      name: string;
    }[];
    return new Map(rows.map((row) => [row.code, row.name]));
  }

  stationCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM stations").get() as { n: number }).n;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  // ---- statistics ----
  //
  // "Measured" means the run reached its final stop and the feed recorded
  // when. Punctuality is late / measured: cancelled and still-running trains
  // are in neither number, and cancellations are reported separately.

  private where(scope: Scope, alias = ""): { sql: string; params: (string | number)[] } {
    const col = (name: string) => (alias ? `${alias}.${name}` : name);
    return scope.category === "all"
      ? { sql: `${col("date")} >= ?`, params: [scope.since] }
      : {
          sql: `${col("date")} >= ? AND ${col("category")} = ?`,
          params: [scope.since, scope.category],
        };
  }

  totals(scope: Scope) {
    const w = this.where(scope);
    return this.db
      .prepare(
        `SELECT COUNT(*) AS runs,
                COUNT(final_delay) AS measured,
                COALESCE(SUM(late), 0) AS late,
                COALESCE(SUM(cancelled), 0) AS cancelled,
                AVG(MAX(final_delay, 0)) AS meanDelay
         FROM trains WHERE ${w.sql}`,
      )
      .get(...w.params) as {
      runs: number;
      measured: number;
      late: number;
      cancelled: number;
      meanDelay: number | null;
    };
  }

  /** Final-stop delays in ascending order, for percentiles. */
  finalDelays(scope: Scope): number[] {
    const w = this.where(scope);
    return this.db
      .prepare(
        `SELECT MAX(final_delay, 0) AS d FROM trains
         WHERE ${w.sql} AND final_delay IS NOT NULL ORDER BY d`,
      )
      .pluck()
      .all(...w.params) as number[];
  }

  /** Always both categories, so the chart can show them side by side. */
  daily(since: string) {
    return this.db
      .prepare(
        `SELECT date, category, COUNT(final_delay) AS measured, COALESCE(SUM(late), 0) AS late
         FROM trains WHERE date >= ? GROUP BY date, category ORDER BY date`,
      )
      .all(since) as { date: string; category: Category; measured: number; late: number }[];
  }

  heatmap(scope: Scope) {
    const w = this.where(scope);
    return this.db
      .prepare(
        `SELECT dow, hour, COUNT(final_delay) AS measured, COALESCE(SUM(late), 0) AS late
         FROM trains WHERE ${w.sql} GROUP BY dow, hour`,
      )
      .all(...w.params) as { dow: number; hour: number; measured: number; late: number }[];
  }

  /** Late runs by recorded cause. A run with two causes counts under both. */
  causes(scope: Scope) {
    const w = this.where(scope, "t");
    return this.db
      .prepare(
        `SELECT c.code, COALESCE(k.name_fi, c.code) AS nameFi, COUNT(*) AS lateRuns
         FROM train_causes c
         JOIN trains t ON t.date = c.date AND t.number = c.number
         LEFT JOIN cause_categories k ON k.code = c.code
         WHERE ${w.sql} AND t.late = 1
         GROUP BY c.code ORDER BY lateRuns DESC`,
      )
      .all(...w.params) as { code: string; nameFi: string; lateRuns: number }[];
  }

  /** How many late runs have any cause recorded at all. */
  lateRunsWithCause(scope: Scope): number {
    const w = this.where(scope, "t");
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM trains t
           WHERE ${w.sql} AND t.late = 1
             AND EXISTS (SELECT 1 FROM train_causes c WHERE c.date = t.date AND c.number = t.number)`,
        )
        .get(...w.params) as { n: number }
    ).n;
  }

  // The ORDER BY repeats the aggregates on purpose: inside an expression,
  // SQLite resolves a bare `late` to the column, not to the SUM(late) alias.
  worstTrains(scope: Scope, minRuns: number, limit: number) {
    const w = this.where(scope);
    return this.db
      .prepare(
        `SELECT number, MIN(type) AS type, MIN(line) AS line, category,
                MIN(origin) AS origin, MIN(destination) AS destination,
                COUNT(final_delay) AS measured, SUM(late) AS late,
                AVG(MAX(final_delay, 0)) AS meanDelay, MAX(final_delay) AS worstDelay
         FROM trains WHERE ${w.sql} AND final_delay IS NOT NULL
         GROUP BY number, category HAVING measured >= ?
         ORDER BY SUM(late) * 1.0 / COUNT(final_delay) DESC, AVG(MAX(final_delay, 0)) DESC LIMIT ?`,
      )
      .all(...w.params, minRuns, limit) as {
      number: number;
      type: string;
      line: string | null;
      category: Category;
      origin: string;
      destination: string;
      measured: number;
      late: number;
      meanDelay: number;
      worstDelay: number;
    }[];
  }

  stationStats(scope: Scope, minArrivals: number) {
    const w = this.where(scope, "t");
    return this.db
      .prepare(
        `SELECT s.station AS code, st.name, st.lat, st.lon,
                COUNT(s.delay) AS measured, COALESCE(SUM(s.late), 0) AS late,
                AVG(MAX(s.delay, 0)) AS meanDelay
         FROM stops s
         JOIN trains t ON t.date = s.date AND t.number = s.number
         JOIN stations st ON st.code = s.station
         WHERE ${w.sql} AND s.delay IS NOT NULL
         GROUP BY s.station HAVING measured >= ?`,
      )
      .all(...w.params, minArrivals) as {
      code: string;
      name: string;
      lat: number;
      lon: number;
      measured: number;
      late: number;
      meanDelay: number;
    }[];
  }

  coverage() {
    return this.db
      .prepare("SELECT MIN(date) AS first, MAX(date) AS last, COUNT(*) AS runs FROM trains")
      .get() as { first: string | null; last: string | null; runs: number };
  }

  live(limit: number) {
    return this.db
      .prepare(
        `SELECT t.number, t.type, t.line, t.category, t.current_delay AS delay,
                o.name AS origin, d.name AS destination, l.name AS lastStation
         FROM trains t
         LEFT JOIN stations o ON o.code = t.origin
         LEFT JOIN stations d ON d.code = t.destination
         LEFT JOIN stations l ON l.code = t.last_station
         WHERE t.running = 1 AND t.current_delay IS NOT NULL
         ORDER BY t.current_delay DESC, t.number LIMIT ?`,
      )
      .all(limit) as {
      number: number;
      type: string;
      line: string | null;
      category: Category;
      delay: number;
      origin: string | null;
      destination: string | null;
      lastStation: string | null;
    }[];
  }

  allStations(): Station[] {
    const rows = this.db.prepare("SELECT code, name, lat, lon, passenger FROM stations").all() as {
      code: string;
      name: string;
      lat: number;
      lon: number;
      passenger: number;
    }[];
    return rows.map((row) => ({ ...row, passenger: row.passenger === 1 }));
  }

  /** What is known about one run, for labelling a dot on the live map. */
  runInfo(date: string, number: number) {
    return this.db
      .prepare(
        `SELECT t.category, t.type, t.line, t.current_delay AS delay,
                o.name AS origin, d.name AS destination
         FROM trains t
         LEFT JOIN stations o ON o.code = t.origin
         LEFT JOIN stations d ON d.code = t.destination
         WHERE t.date = ? AND t.number = ?`,
      )
      .get(date, number) as
      | {
          category: Category;
          type: string;
          line: string | null;
          delay: number | null;
          origin: string | null;
          destination: string | null;
        }
      | undefined;
  }

  /**
   * One day's passenger runs as timed points, for the map's time-lapse.
   * Each run is its origin at the scheduled departure, then every stop at
   * the time it was actually reached (scheduled time plus recorded delay).
   */
  replay(date: string) {
    const rows = this.db
      .prepare(
        `SELECT t.number, t.category, t.type, t.line, t.sched_dep AS dep,
                o.lon AS olon, o.lat AS olat, o.name AS origin, d.name AS destination,
                s.scheduled, s.delay, st.lon, st.lat
         FROM trains t
         JOIN stations o ON o.code = t.origin
         JOIN stations d ON d.code = t.destination
         JOIN stops s ON s.date = t.date AND s.number = t.number
         JOIN stations st ON st.code = s.station
         WHERE t.date = ? AND t.cancelled = 0 AND s.delay IS NOT NULL
         ORDER BY t.number, s.seq`,
      )
      .all(date) as {
      number: number;
      category: Category;
      type: string;
      line: string | null;
      dep: number;
      olon: number;
      olat: number;
      origin: string;
      destination: string;
      scheduled: number;
      delay: number;
      lon: number;
      lat: number;
    }[];

    const runs = new Map<
      number,
      {
        number: number;
        name: string;
        category: Category;
        origin: string;
        destination: string;
        /** [lon, lat, time in ms, delay in minutes] */
        points: [number, number, number, number][];
      }
    >();
    for (const row of rows) {
      let run = runs.get(row.number);
      if (!run) {
        run = {
          number: row.number,
          name: `${row.line ?? row.type} ${row.number}`,
          category: row.category,
          origin: row.origin,
          destination: row.destination,
          points: [[row.olon, row.olat, row.dep, 0]],
        };
        runs.set(row.number, run);
      }
      // Times must not run backwards: an early arrival can precede the previous point.
      const previous = run.points.at(-1)?.[2] ?? row.dep;
      run.points.push([
        row.lon,
        row.lat,
        Math.max(previous, row.scheduled + row.delay * 60_000),
        row.delay,
      ]);
    }
    return [...runs.values()];
  }

  runningCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM trains WHERE running = 1").get() as { n: number }
    ).n;
  }
}
