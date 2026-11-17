/**
 * Loads history from Digitraffic, one request per day, newest first.
 *
 *   npm run backfill              # last 30 days
 *   npm run backfill -- --days 90
 *
 * Safe to re-run and safe to run while the server is collecting: ingest is
 * idempotent and never replaces a newer version of a run with an older one.
 */
import { Repository } from "../src/db.js";
import { Collector } from "../src/lib/collector.js";
import { Digitraffic } from "../src/lib/digitraffic.js";
import { summarize, type TrainSummary } from "../src/lib/summarize.js";

const arg = process.argv.indexOf("--days");
const days = arg > -1 ? Number(process.argv[arg + 1]) : 30;
if (!Number.isInteger(days) || days < 1 || days > 365) {
  console.error("--days must be an integer between 1 and 365");
  process.exit(1);
}

const api = new Digitraffic(process.env.DIGITRAFFIC_USER ?? "peron-train-stats/1.0");
const repo = new Repository(process.env.DB_PATH ?? "data/peron.db");
const PAUSE_MS = 1000; // one request a second is plenty polite for a daily file

await new Collector(api, repo).loadMetadata(true);

let total = 0;
for (let back = 0; back < days; back++) {
  const date = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
  try {
    const trains = await api.trainsOn(date);
    const summaries = trains.map(summarize).filter((t): t is TrainSummary => t !== null);
    const written = repo.upsertTrains(summaries);
    total += written;
    console.log(
      `${date}  ${String(summaries.length).padStart(5)} passenger runs, ${written} written`,
    );
  } catch (err) {
    console.error(`${date}  failed: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
}

repo.close();
console.log(`done: ${total} runs written over ${days} days`);
