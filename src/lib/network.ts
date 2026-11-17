import type { RawTrain } from "./summarize.js";

/**
 * Derives the shape of the rail network from a day of traffic.
 *
 * A train's timetable lists every point it passes, including junctions it
 * does not stop at. Joining each consecutive pair, over every train of every
 * kind, traces the lines that are actually in use, which is all a map needs.
 * No track geometry is downloaded: the network is whatever the trains ran on.
 */
export function networkEdges(trains: RawTrain[]): [string, string][] {
  const seen = new Set<string>();
  for (const train of trains) {
    let previous: string | null = null;
    for (const row of train.timeTableRows) {
      const here = row.stationShortCode;
      if (previous !== null && previous !== here) {
        seen.add(previous < here ? `${previous}|${here}` : `${here}|${previous}`);
      }
      previous = here;
    }
  }
  return [...seen].sort().map((pair) => pair.split("|") as [string, string]);
}
