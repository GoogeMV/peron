# peron

How late do trains in Finland actually run? peron collects every passenger train run from Fintraffic's open rail feed and turns it into punctuality statistics: on-time share by day, the hours and stations where delays concentrate, the recorded causes, the least punctual trains, and a live board of what is running late right now.

*peron* is Romanian for a station platform.

## Why Finland

The project started as a delay tracker for Romanian railways. CFR's timetable is open data, but live delays are only served from pages behind reCAPTCHA, and working around a bot check is not something to build a project on. Finland publishes the same information properly: an official API, no key, CC BY 4.0, with history and delay causes. The code is feed-specific in two files ([`digitraffic.ts`](src/lib/digitraffic.ts) and [`summarize.ts`](src/lib/summarize.ts)); everything after that works on a neutral summary of a train run.

## Run it

```bash
npm install
cp .env.example .env
npm run backfill            # last 30 days, about a minute
npm run dev
```

`npm run backfill -- --days 90` loads more. The server then follows the live feed on its own, so the history keeps growing while it runs.

## Live map

`/map` shows every train in Finland as a moving light on the rail network, coloured by how late it is; very late trains send out a slow ring. **Replay yesterday** plays the previous day as a time-lapse, ten minutes of traffic per second.

- **The network is not downloaded, it is derived.** A train timetable lists every junction it passes. Joining consecutive points over one full day of traffic traces the lines actually in use ([`network.ts`](src/lib/network.ts)).
- **Live positions are GPS** from the feed, polled every 10 seconds by the server and shared by every open map; dots glide between reports.
- **The replay is a reconstruction.** It moves each train in a straight line between its stops at the times it actually reached them, so replayed trains cut corners that real track does not. Freight is live-only.

## How it works

```
 Digitraffic                      peron
 ┌──────────────────┐  backfill   ┌────────────┐   ┌─────────────────────┐
 │ /trains/{date}   │────────────►│            │   │ SQLite              │
 │                  │             │ summarize  │──►│  trains (one / run) │──► /api/dashboard
 │ /live-trains     │────────────►│ (pure)     │   │  stops              │──► /api/live
 │   ?version=N     │  every 30s  │            │   │  train_causes       │
 └──────────────────┘  cursor = N └────────────┘   └─────────────────────┘
```

**One pure function carries the domain.** [`summarize`](src/lib/summarize.ts) reduces a train from the feed (dozens of timetable rows, most of them junctions it only passes) to one run: origin, destination, delay at each commercial stop, delay at the final stop, causes. Everything that decides a number on the page is in there, and it is tested against real trains saved from the feed.

**Ingest is idempotent, so two writers can share a database.** The feed sends a full snapshot of a run every time it changes. Storing one means deleting that run's rows and writing them again, with one guard: an older version never replaces a newer one. That is what lets the backfill run while the live collector is running, and what makes a crash mid-poll harmless.

**The live feed is followed with a cursor, not a clock.** Every change in the feed carries a growing version number. The collector asks for "everything after version N", ingests it, then stores the new N. Ingest first, cursor second: if the process dies in between, a few trains are read twice, which idempotent ingest absorbs. If the feed fails, the cursor does not move and nothing is skipped.

**"Late" depends on the kind of train.** A run is late when it reaches its final stop 5 or more minutes behind schedule for long-distance trains, 3 or more for commuter trains. One threshold for both would flatter one and punish the other. The thresholds are a choice, stated on the page and defined in one place.

**Punctuality is counted over completed runs.** Cancelled trains and trains still running are in neither the numerator nor the denominator; cancellations are reported as their own figure. A cancelled train is not "on time".

**Mean delay counts early arrivals as zero,** and the page leads with the median and the 90th percentile instead, because a handful of two-hour delays moves the mean far more than it moves anyone's commute.

**Hours and weekdays are Finnish local time,** computed with the IANA timezone at ingest, so the heatmap is right across daylight-saving changes and wherever the server runs.

**A minute of caching.** The aggregates change only as fast as trains finish, so each filter combination is computed at most once a minute.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/dashboard?days=30&category=all` | Totals, daily series, weekday × hour grid, causes, least punctual trains, station statistics. `category` is `all`, `long` or `commuter` |
| GET | `/api/network`, `/api/positions`, `/api/replay` | Map data: stations and lines, live GPS positions, yesterday as timed points |
| GET | `/api/live` | Trains running now, most delayed first, and when the feed was last checked |
| GET | `/healthz` | Liveness and collector state |

## Known limits

- **Finland only**, and only passenger services; cargo and shunting moves are dropped at ingest.
- **Final-stop punctuality.** A train that runs 20 minutes late all day and recovers before its terminus counts as on time. The station map uses every stop and tells that other half.
- **Causes are what staff recorded.** A run with two causes counts under both; the English labels are my glosses of the feed's Finnish categories.
- **Day boundaries are UTC departure dates** for the period filter; the heatmap uses local time.
- **Train numbers are not routes.** The "least punctual" table groups by number, and a number can be reassigned at a timetable change.
- **Single process, SQLite.** Fine for one country's rail network (about 1,200 runs a day); a second collector would only do duplicate work.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8084` | |
| `DB_PATH` | `data/peron.db` | |
| `DIGITRAFFIC_USER` | `peron-train-stats/1.0` | Application name sent to the feed, as its terms ask |
| `COLLECT` | `true` | `false` serves stored data without following the live feed |
| `POLL_MS` | `30000` | |

## Development

```bash
npm test
npm run typecheck
npm run lint
```

Stack: Fastify 5, TypeBox, better-sqlite3, Vitest, Biome, TypeScript in strict mode. The frontend is plain HTML, CSS and SVG drawn by hand, with no chart library and no build step.

## Data

Train data from [Fintraffic / digitraffic.fi](https://www.digitraffic.fi/en/railway-traffic/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
