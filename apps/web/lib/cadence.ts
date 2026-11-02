/** Single source of truth for scouting freshness: the traffic kick starts the scouting chain at most this often (sweep + watchlist books + alerts). */
export const SCOUT_KICK_MS = 30 * 60_000;
/** The chain's full pass (every kept market's book, screen, research) runs at most this often, unless a sweep changes the universe (new or closed markets). */
export const FULL_PASS_MS = 2 * 3_600_000;
/** Data counts as stale one kick after a missed full pass: with an empty watchlist only the full pass writes snapshots. */
export const STALE_MS = FULL_PASS_MS + SCOUT_KICK_MS;
