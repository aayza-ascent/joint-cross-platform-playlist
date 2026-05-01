export const DAILY_QUOTA = 10_000;
export const QUOTA_SAFETY_MARGIN = 500;

export interface QuotaAccounter {
  spend(units: number): Promise<void>;
  remaining(): Promise<number>;
}

export function pacificDate(now: Date = new Date()): string {
  // YouTube quota resets at midnight America/Los_Angeles. Format YYYY-MM-DD
  // in that timezone via Intl.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

// Computes the next quota reset time as a Date, useful for surfacing
// "resets in X hours" to users. Midnight Pacific each day.
export function nextPacificMidnight(now: Date = new Date()): Date {
  const today = pacificDate(now);
  // Pick a known offset by parsing midnight in Pacific as a UTC instant.
  // We use Intl trick: format the *next* day's midnight Pacific as UTC.
  const [y, m, d] = today.split("-").map(Number);
  // Tomorrow Pacific
  const tomorrowUtc = new Date(Date.UTC(y, m - 1, d + 1));
  // Compute Pacific offset for tomorrow midnight by formatting back.
  const offsetFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  });
  const parts = offsetFmt.formatToParts(tomorrowUtc);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
  const m2 = /GMT([+-]?\d+)/.exec(tz);
  const offsetHours = m2 ? Number(m2[1]) : -8;
  return new Date(Date.UTC(y, m - 1, d + 1, -offsetHours, 0, 0));
}

export class InMemoryQuotaAccounter implements QuotaAccounter {
  used = 0;
  async spend(units: number) {
    this.used += units;
  }
  async remaining() {
    return Math.max(0, DAILY_QUOTA - this.used);
  }
}
