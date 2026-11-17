import type { Repository } from "../db.js";
import type { Digitraffic } from "./digitraffic.js";
import { summarize, type TrainSummary } from "./summarize.js";

const CURSOR_KEY = "live_version";
/** A run still marked running this long after departure has stopped reporting. */
const STALE_RUNNING_MS = 36 * 60 * 60 * 1000;

export interface CollectorState {
  lastPollAt: number | null;
  lastError: string | null;
  cursor: number;
}

/**
 * Follows the live feed. Each tick asks for trains changed since the stored
 * cursor, ingests them and advances the cursor, in that order: if the
 * process dies between the two, the next start re-reads a few trains, and
 * ingest is idempotent, so that costs nothing.
 */
export class Collector {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  readonly state: CollectorState;

  constructor(
    private readonly api: Digitraffic,
    private readonly repo: Repository,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.state = {
      lastPollAt: null,
      lastError: null,
      cursor: Number(repo.getMeta(CURSOR_KEY) ?? 0),
    };
  }

  /** Station names and cause labels change rarely; fetch them once. */
  async loadMetadata(force = false): Promise<void> {
    if (!force && this.repo.stationCount() > 0) return;
    this.repo.replaceStations(await this.api.stations());
    this.repo.replaceCauseCategories(await this.api.causeCategories());
  }

  async tick(now = Date.now()): Promise<number> {
    const changed = await this.api.changedSince(this.state.cursor);
    const summaries = changed.map(summarize).filter((t): t is TrainSummary => t !== null);
    const written = this.repo.upsertTrains(summaries);

    // The cursor covers every train in the response, including the cargo
    // and shunting moves that were skipped.
    const cursor = changed.reduce((max, train) => Math.max(max, train.version), this.state.cursor);
    this.repo.setMeta(CURSOR_KEY, String(cursor));
    this.repo.expireRunning(now - STALE_RUNNING_MS);

    this.state.cursor = cursor;
    this.state.lastPollAt = now;
    this.state.lastError = null;
    return written;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    const run = () => {
      if (this.busy) return;
      this.busy = true;
      this.tick()
        .catch((err) => {
          this.state.lastError = err instanceof Error ? err.message : String(err);
          this.log(`poll failed: ${this.state.lastError}`);
        })
        .finally(() => {
          this.busy = false;
        });
    };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
