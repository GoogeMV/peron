/** The parts of a Digitraffic train this app reads. The feed carries more. */
export interface RawRow {
  type: "ARRIVAL" | "DEPARTURE";
  stationShortCode: string;
  scheduledTime: string;
  actualTime?: string;
  differenceInMinutes?: number;
  commercialStop?: boolean;
  cancelled: boolean;
  causes?: { categoryCode: string }[];
}

export interface RawTrain {
  trainNumber: number;
  departureDate: string;
  trainCategory: string;
  trainType: string;
  commuterLineID?: string;
  operatorShortCode: string;
  cancelled: boolean;
  runningCurrently: boolean;
  version: number;
  timeTableRows: RawRow[];
}

export type Category = "long" | "commuter";

export interface StopSummary {
  seq: number;
  station: string;
  scheduled: number;
  /** Minutes late on arrival (negative = early); null if not measured. */
  delay: number | null;
  late: boolean | null;
  cancelled: boolean;
}

export interface TrainSummary {
  date: string;
  number: number;
  category: Category;
  type: string;
  line: string | null;
  operator: string;
  origin: string;
  destination: string;
  scheduledDeparture: number;
  /** Hour (0-23) and weekday (0 = Monday) of departure, in Finnish local time. */
  hour: number;
  dow: number;
  cancelled: boolean;
  running: boolean;
  /** Minutes late at the final stop; null until the train has arrived (or if it never did). */
  finalDelay: number | null;
  late: boolean | null;
  maxDelay: number | null;
  /** For running trains: delay at the most recent measured point, and where that was. */
  currentDelay: number | null;
  lastStation: string | null;
  /** Distinct cause category codes recorded anywhere along the route. */
  causes: string[];
  version: number;
  stops: StopSummary[];
}

/**
 * A train counts as late when it reaches a stop this many minutes behind
 * schedule. Commuter services run to a tighter standard than long-distance
 * ones, so one threshold for both would flatter one and punish the other.
 */
export const LATE_THRESHOLD_MIN: Record<Category, number> = { long: 5, commuter: 3 };

const CATEGORIES: Record<string, Category> = { "Long-distance": "long", Commuter: "commuter" };

const helsinki = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Helsinki",
  hour: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Hour and weekday in Finland, whatever timezone this process runs in. */
export function helsinkiTime(ms: number): { hour: number; dow: number } {
  const parts = helsinki.formatToParts(ms);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { hour: Number(get("hour")), dow: WEEKDAYS.indexOf(get("weekday")) };
}

/**
 * Reduces one train from the feed to what the statistics need. Pure: the
 * same input always gives the same summary, which is what makes re-ingesting
 * a train (backfill over live data, or a later version of the same run)
 * safe to do any number of times.
 *
 * Returns null for anything that is not a passenger service (cargo,
 * shunting, light engines) or has no commercial stops.
 */
export function summarize(raw: RawTrain): TrainSummary | null {
  const category = CATEGORIES[raw.trainCategory];
  if (!category) return null;

  // Rows also list every junction the train merely passes through.
  const rows = raw.timeTableRows.filter((row) => row.commercialStop);
  const first = rows[0];
  const arrivals = rows.filter((row) => row.type === "ARRIVAL");
  const last = arrivals.at(-1);
  if (!first || !last) return null;

  const threshold = LATE_THRESHOLD_MIN[category];
  const measured = (row: RawRow): number | null =>
    row.actualTime !== undefined && !row.cancelled && row.differenceInMinutes !== undefined
      ? row.differenceInMinutes
      : null;

  const stops = arrivals.map((row, seq): StopSummary => {
    const delay = measured(row);
    return {
      seq,
      station: row.stationShortCode,
      scheduled: Date.parse(row.scheduledTime),
      delay,
      late: delay === null ? null : delay >= threshold,
      cancelled: row.cancelled,
    };
  });

  const delays = stops.map((stop) => stop.delay).filter((d): d is number => d !== null);
  const finalDelay = raw.cancelled ? null : measured(last);

  // The feed lists rows in travel order, so the last one with an actual time
  // is where the train most recently was.
  const latest = raw.timeTableRows.findLast((row) => measured(row) !== null);

  const scheduledDeparture = Date.parse(first.scheduledTime);
  return {
    date: raw.departureDate,
    number: raw.trainNumber,
    category,
    type: raw.trainType,
    line: raw.commuterLineID || null,
    operator: raw.operatorShortCode,
    origin: first.stationShortCode,
    destination: last.stationShortCode,
    scheduledDeparture,
    ...helsinkiTime(scheduledDeparture),
    cancelled: raw.cancelled,
    running: raw.runningCurrently,
    finalDelay,
    late: finalDelay === null ? null : finalDelay >= threshold,
    maxDelay: delays.length > 0 ? Math.max(...delays) : null,
    currentDelay: latest ? measured(latest) : null,
    lastStation: latest?.stationShortCode ?? null,
    causes: [
      ...new Set(raw.timeTableRows.flatMap((row) => (row.causes ?? []).map((c) => c.categoryCode))),
    ].sort(),
    version: raw.version,
    stops,
  };
}
