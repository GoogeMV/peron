import type { Station } from "../db.js";
import type { RawTrain } from "./summarize.js";

const BASE = "https://rata.digitraffic.fi/api/v1";

export type Fetch = typeof fetch;

export interface TrainLocation {
  number: number;
  date: string;
  at: number;
  speed: number;
  lon: number;
  lat: number;
}

/**
 * Client for Fintraffic's open rail API (https://www.digitraffic.fi/en/railway-traffic/).
 * The data is CC BY 4.0 and needs no key; the service asks callers to name
 * their application in a Digitraffic-User header, and that is all it gets.
 */
export class Digitraffic {
  constructor(
    private readonly user: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      signal: AbortSignal.timeout(60_000),
      headers: { "Digitraffic-User": this.user, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Digitraffic ${path} answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** Every train that departed on the given date (YYYY-MM-DD), finished or not. */
  trainsOn(date: string): Promise<RawTrain[]> {
    return this.get(`/trains/${date}`);
  }

  /**
   * Trains changed since `version`. The feed stamps every change with a
   * growing version number, so polling with the highest one seen so far
   * returns only what is new; nothing is fetched twice and nothing is missed
   * across a restart.
   */
  changedSince(version: number): Promise<RawTrain[]> {
    return this.get(`/live-trains?version=${version}`);
  }

  /** Latest reported GPS position of every train currently sending one. */
  async trainLocations(): Promise<TrainLocation[]> {
    const raw =
      await this.get<
        {
          trainNumber: number;
          departureDate: string;
          timestamp: string;
          speed: number;
          location: { coordinates: [number, number] };
        }[]
      >("/train-locations/latest");
    return raw.map((r) => ({
      number: r.trainNumber,
      date: r.departureDate,
      at: Date.parse(r.timestamp),
      speed: r.speed,
      lon: r.location.coordinates[0],
      lat: r.location.coordinates[1],
    }));
  }

  async stations(): Promise<Station[]> {
    const raw =
      await this.get<
        {
          stationShortCode: string;
          stationName: string;
          latitude: number;
          longitude: number;
          passengerTraffic: boolean;
        }[]
      >("/metadata/stations");
    return raw.map((s) => ({
      code: s.stationShortCode,
      // The feed appends " asema" (station) to some names.
      name: s.stationName.replace(/ asema$/, ""),
      lat: s.latitude,
      lon: s.longitude,
      passenger: s.passengerTraffic,
    }));
  }

  async causeCategories(): Promise<{ code: string; nameFi: string }[]> {
    const raw = await this.get<{ categoryCode: string; categoryName: string }[]>(
      "/metadata/cause-category-codes",
    );
    return raw.map((c) => ({ code: c.categoryCode, nameFi: c.categoryName }));
  }
}
