/** Single source of truth for scouting freshness: the traffic kick starts the cheap chain (sweep + watchlist books + alerts) at most this often. */
export const SCOUT_KICK_MS = 30 * 60_000;
/** Every kept market's book, the screen and research run once a day from the Vercel crons (vercel.json, 01:00-05:30 UTC), never from a kick. */
export const DAILY_PASS_MS = 24 * 3_600_000;
/** Data counts as stale an hour past a missed daily pass: with an empty watchlist only the daily all-books snapshot writes snapshots. */
export const STALE_MS = DAILY_PASS_MS + 3_600_000;
