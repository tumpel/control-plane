import type { HostHealthSchema } from "@tumpel/schemas";
import type { z } from "zod";

export type HostHealth = z.infer<typeof HostHealthSchema>;

const WINDOW_MS = 60_000;
const TRIP_SPAN_MS = 3_600_000;
const TRIPS_TO_UNHEALTHY = 3;

export type Admission =
  | { kind: "Admitted" }
  | { kind: "Refused"; framesPerMinute: number; retryAfter: number; tripped: HostHealth | null };

export type TripStore = {
  save(trips: number[]): void;
  clear(): void;
};

const windowOf = (at: number): number => at - (at % WINDOW_MS);

export class HostFrameMeter {
  #framesPerMinute: number;
  readonly #store: TripStore;
  #windowStart = 0;
  #count = 0;
  #counted = 0;
  #trips: number[];
  #health: HostHealth;

  constructor(framesPerMinute: number, health: HostHealth, trips: number[], store: TripStore) {
    this.#framesPerMinute = framesPerMinute;
    this.#health = health;
    this.#trips = trips;
    this.#store = store;
  }

  get framesPerMinute(): number {
    return this.#framesPerMinute;
  }

  relimit(framesPerMinute: number): void {
    this.#framesPerMinute = framesPerMinute;
  }

  health(): HostHealth {
    return this.#health;
  }

  admit(seq: number, now: number): Admission {
    if (seq <= this.#counted) return { kind: "Admitted" };
    this.#counted = seq;
    const start = windowOf(now);
    if (start !== this.#windowStart) {
      this.#windowStart = start;
      this.#count = 0;
    }
    this.#count += 1;
    if (this.#count <= this.framesPerMinute) return { kind: "Admitted" };
    const refused = { kind: "Refused", framesPerMinute: this.framesPerMinute, retryAfter: start + WINDOW_MS } as const;
    if (this.#count > this.framesPerMinute + 1) return { ...refused, tripped: null };
    this.#trips = [...this.#trips.filter((at) => now - at < TRIP_SPAN_MS), now];
    this.#store.save(this.#trips);
    const tripped =
      this.#health === "Unhealthy" || this.#trips.length >= TRIPS_TO_UNHEALTHY ? "Unhealthy" : "RateLimited";
    return { ...refused, tripped };
  }

  recovered(now: number): boolean {
    if (this.#health !== "RateLimited") return false;
    const last = this.#trips.at(-1);
    return last === undefined || now >= windowOf(last) + 2 * WINDOW_MS;
  }

  settle(health: HostHealth): void {
    this.#health = health;
  }

  restore(): void {
    this.#trips = [];
    this.#store.clear();
    this.#health = "Healthy";
  }
}

export const rateLimitDetail = (hostId: string, framesPerMinute: number): string =>
  `host ${hostId} sent more than ${framesPerMinute} frames a minute`;
