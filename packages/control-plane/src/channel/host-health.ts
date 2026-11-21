import type { HostHealthSchema } from "@tumpel/schemas";
import type { z } from "zod";

export type HostHealth = z.infer<typeof HostHealthSchema>;

const WINDOW_MS = 60_000;
const TRIP_SPAN_MS = 3_600_000;
const TRIPS_TO_UNHEALTHY = 3;

export type Admission =
  | { kind: "Admitted" }
  | { kind: "Refused"; framesPerMinute: number; retryAfter: number; changed: HostHealth | null };

export class HostFrameMeter {
  readonly framesPerMinute: number;
  #windowStart = 0;
  #count = 0;
  #trippedWindow: number | null = null;
  #trips: number[] = [];
  #health: HostHealth;

  constructor(framesPerMinute: number, health: HostHealth) {
    this.framesPerMinute = framesPerMinute;
    this.#health = health;
  }

  health(): HostHealth {
    return this.#health;
  }

  admit(now: number): Admission {
    const start = now - (now % WINDOW_MS);
    if (start !== this.#windowStart) {
      this.#windowStart = start;
      this.#count = 0;
    }
    this.#count += 1;
    if (this.#count <= this.framesPerMinute) return { kind: "Admitted" };
    const refused = { kind: "Refused", framesPerMinute: this.framesPerMinute, retryAfter: start + WINDOW_MS } as const;
    if (this.#count > this.framesPerMinute + 1) return { ...refused, changed: null };
    this.#trippedWindow = start;
    this.#trips = [...this.#trips.filter((at) => now - at < TRIP_SPAN_MS), now];
    const next: HostHealth =
      this.#health === "Unhealthy" || this.#trips.length >= TRIPS_TO_UNHEALTHY ? "Unhealthy" : "RateLimited";
    const changed = next === this.#health ? null : next;
    this.#health = next;
    return { ...refused, changed };
  }

  recovered(now: number): boolean {
    if (this.#health !== "RateLimited") return false;
    if (this.#trippedWindow !== null && now < this.#trippedWindow + 2 * WINDOW_MS) return false;
    this.#health = "Healthy";
    return true;
  }

  restore(): boolean {
    if (this.#health === "Healthy") return false;
    this.#health = "Healthy";
    return true;
  }
}

export const rateLimitDetail = (hostId: string, framesPerMinute: number): string =>
  `host ${hostId} sent more than ${framesPerMinute} frames a minute`;
