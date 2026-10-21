/** Single source of truth for scouting freshness: the traffic kick starts the sweep→snapshot→screen→research→monitor chain at most this often. */
export const SCOUT_KICK_MS = 30 * 60_000;
/** Data counts as stale after missing two kicks (one slow or skipped kick is not an alarm). */
export const STALE_MS = 2 * SCOUT_KICK_MS;
