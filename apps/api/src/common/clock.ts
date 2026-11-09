export const CLOCK = Symbol("CLOCK");

/** The only source of "today" and "now" (TR-PLT-09), so tests can freeze and move time. */
export interface Clock {
  /** Today's calendar date in Oman (YYYY-MM-DD). */
  today(): string;
  /** The current moment, epoch milliseconds. */
  now(): number;
}

export const omanClock: Clock = {
  today: () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Muscat" }).format(new Date()),
  now: () => Date.now(),
};
