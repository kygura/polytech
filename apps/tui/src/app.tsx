import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "./auth";
import { BASE, post, useFetch } from "./api";
import { hhmm } from "./fmt";
import { streamEvents } from "./sse";
import type { Autonomy as AutT, KillResult, Mode } from "./types";
import { type Ctx, MODE_COLOR, MODE_NAME } from "./ui";
import { Autonomy } from "./views/autonomy";
import { Calibration } from "./views/calibration";
import { Fleet } from "./views/fleet";
import { Paper } from "./views/paper";
import { Settings } from "./views/settings";
import { Watchlist } from "./views/watchlist";

const VIEWS = ["Watchlist", "Fleet", "Calib", "Book", "Autonomy", "Settings"] as const;
// Which SSE events make a view refetch.
const RELEVANT: RegExp[] = [/^(sweep|snapshot|screen|thesis|pod|mode)\./, /^pod\./, /^calibration\./, /^(paper|snapshot|mode|order)\./, /^(mode|proposal|order|recon)\./, /^$/];
const KEYS = "j/k move  Enter open  / filter  s/S sort  r research  p pin  m mute  R refresh  K kill  ? help  q quit";
const KEYS_NARROW = "j/k Enter / s/S r p m R K ? q";
const HELP = [
  "1-6 Tab/S-Tab  switch view        j/k ↑/↓  move      Enter  open   Esc  back",
  "/  filter (Enter apply, Esc clear) s/S  sort col/dir  h/l ←/→  watchlist tab",
  "r  re-research   p  pin   m  mute   R  refresh        q  quit",
  "Book: h/l  Live/Paper tab   x  close selected paper position at best bid",
  "K  KILL SWITCH → L0 (any view; with live orders press K twice)",
  "Autonomy: 0-2 set mode, 3-4 refused   j/k select   a approve (y confirms)   x reject",
  "Calibration: Tab cycles selects, ←/→ change value",
];

export function App() {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [view, setView] = useState(0), [help, setHelp] = useState(false), [typing, setTyping] = useState(false);
  const [tick, setTick] = useState(0), [live, setLive] = useState(false), [sweptAt, setSweptAt] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ text: string; color?: string; kill?: boolean } | null>(null);
  const [mode, setMode] = useState<Mode>("L0"), [modeTick, setModeTick] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [prompt, setPrompt] = useState<{ text: string; key: string; run: () => void; color: string } | null>(null);
  const [killFailed, setKillFailed] = useState<NonNullable<KillResult["failed"]>>([]);
  const viewRef = useRef(view);
  viewRef.current = view;

  const aut = useFetch<AutT>("/api/autonomy", modeTick + tick).data;
  useEffect(() => void (aut && setMode(aut.mode)), [aut]);

  useEffect(() => {
    const ac = new AbortController();
    streamEvents(
      new URL("/api/stream", BASE), authHeaders,
      (e) => {
        if (e.event === "ping") return;
        if (/^(sweep|snapshot)\./.test(e.event)) setSweptAt(Date.now());
        if (/^(mode|proposal|order|recon)\./.test(e.event)) setModeTick((t) => t + 1); // header badges + live order count
        if (RELEVANT[viewRef.current]!.test(e.event)) setTick((t) => t + 1);
      },
      setLive, ac.signal,
    ).catch(exit);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => (ac.abort(), clearInterval(timer));
  }, []);

  const say = (text: string, color?: string, kill = false) => {
    setFlash({ text, color, kill });
    setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), 3000);
  };
  const kill = async () => {
    try {
      const r = await post<KillResult>("/api/autonomy/kill");
      const n = r.cancelled, failed = r.failed;
      setMode("L0");
      setModeTick((t) => t + 1);
      setKillFailed(failed);
      if (failed.length) say(`KILLED → L0 · ${n} cancelled · ${failed.length} FAILED (see Autonomy)`, "red");
      else say(`KILLED → L0${n ? ` · ${n} cancelled` : ""}`, undefined, true);
    } catch (e) {
      say(`kill failed: ${(e as Error).message}`, "red");
    }
  };

  const confirm = (text: string, k: string, run: () => void, color = "yellow", ms?: number) => {
    const p = { text, key: k, run, color };
    setPrompt(p);
    if (ms) setTimeout(() => setPrompt((x) => (x === p ? null : x)), ms);
  };
  useInput(
    (ch, key) => {
      if (prompt) return setPrompt(null), ch === prompt.key ? prompt.run() : say("aborted", "gray");
      if (help) return setHelp(false);
      if (ch === "q") return exit();
      const live = aut?.liveOpenOrders ?? 0;
      if (ch === "K") return live > 0 ? confirm(`K again: kill + cancel ${live} LIVE orders · any other key aborts`, "K", () => void kill(), "red", 5000) : void kill();
      if (ch === "?") return setHelp(true);
      if (ch === "R") return setTick((t) => t + 1);
      // Autonomy view owns 0-4 (mode keys); Calibration owns plain Tab (select cycling).
      const digit = /^[1-6]$/.test(ch) && !(view === 4 && ch < "5") ? Number(ch) - 1 : null;
      if (digit != null) setView(digit);
      else if (key.tab && (key.shift || view !== 2)) setView((v) => (v + (key.shift ? 5 : 1)) % 6);
    },
    { isActive: !typing },
  );

  const h = Math.max(5, rows - 4), w = columns;
  const ctx: Ctx = { tick, w, h, active: !help && !typing && !prompt, mode, flash: say, setTyping, confirm: (t, k, run) => confirm(t, k, run), killFailed };
  const stale = sweptAt != null && now - sweptAt > 5 * 60_000 ? `STALE ${Math.round((now - sweptAt) / 60_000)}m` : null;
  const rule = "─".repeat(Math.max(0, w - 2));
  const body = [<Watchlist ctx={ctx} />, <Fleet ctx={ctx} />, <Calibration ctx={ctx} />, <Paper ctx={ctx} />, <Autonomy ctx={ctx} onMode={setMode} />, <Settings ctx={ctx} />][view];

  return (
    <Box flexDirection="column" width={w} height={rows}>
      {/* Nav truncates first; SSE dot, mode and K=KILL stay visible at any width. */}
      <Box>
        <Box flexShrink={1}>
          <Text wrap="truncate">
            <Text bold> PM-EDGE  </Text>
            {VIEWS.map((v, i) => <Text key={v} color={i === view ? "cyan" : undefined} bold={i === view}>{`[${i + 1}]${v} `}</Text>)}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text>
            {"     "}
            {live ? <Text color="green">● live</Text> : <Text color="red">● offline</Text>}
            {"  "}
            <Text color={MODE_COLOR[mode]} bold>{mode} {MODE_NAME[mode]}</Text>
            {aut?.pendingCount ? <Text color="yellow" bold>{`  ${aut.pendingCount} PENDING`}</Text> : null}
            {aut?.recon?.status === "mismatch" && <Text color="red" bold>  RECON ✗</Text>}
            <Text color="gray">   K=KILL</Text>
          </Text>
        </Box>
      </Box>
      <Text color="gray"> {rule}</Text>
      <Box flexDirection="column" height={h} overflow="hidden">
        {help ? (
          <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
            <Text bold color="cyan">Keys (any key closes)</Text>
            {HELP.map((l) => <Text key={l}>{l}</Text>)}
          </Box>
        ) : body}
      </Box>
      <Text color="gray"> {rule}</Text>
      <Text wrap="truncate">
        {" "}
        {prompt ? <Text color={prompt.color} bold>{prompt.text}</Text> : flash ? (
          flash.kill ? <Text backgroundColor="red" color="white" bold> {flash.text} </Text> : <Text color={flash.color}>{flash.text}</Text>
        ) : <Text color="gray">{(w < 100 ? KEYS_NARROW : KEYS) + (view === 4 ? (w < 100 ? " a x" : "  a approve  x reject") : "")}</Text>}
        {"   "}
        {stale ? <Text color="yellow">{stale}</Text> : <Text color="gray">{sweptAt ? `swept ${hhmm(sweptAt)}` : ""}</Text>}
      </Text>
    </Box>
  );
}
