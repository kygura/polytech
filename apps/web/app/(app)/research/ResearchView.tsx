"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorBar } from "../../../components/ErrorBar";
import { FormGroup } from "../../../components/FormGroup";
import { Flat } from "../../../components/pageParts";
import { Button, Panel } from "../../../components/ui";
import pg from "../../../components/page.module.css";
import { hm } from "../../../components/fmt";
import { FilterForm } from "../../../components/research/FilterForm";
import { PreviewPane, type Match, type PreviewState } from "../../../components/research/PreviewPane";
import { NEW_ID, ProfileTable } from "../../../components/research/ProfileTable";
import { ProfileToolbar, type Status } from "../../../components/research/ProfileToolbar";
import { ScheduleForm } from "../../../components/research/ScheduleForm";
import { SteeringForm } from "../../../components/research/SteeringForm";
import { blocker, buildInput, fromProfile, mapIssues, newDraft, scope, toFilter, toProfile, type Draft, type Profile } from "../../../components/research/steering";
import ui from "../../../components/ui.module.css";
import { inInput } from "../../../hooks/useGlobalKeys";
import cx from "./research.module.css";

const API = "/api/research/profiles";
const idle: PreviewState = { state: "idle", matches: null, at: null, limit: 10, hint: "" };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const byName = (a: Profile, b: Profile) => a.name.localeCompare(b.name);
type Fail = { text: string; retry?: () => void };

async function call(method: string, url: string, body?: unknown) {
  try {
    const r = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { r, j: await r.json().catch(() => null) };
  } catch { return null; }
}
const why = (x: Awaited<ReturnType<typeof call>>) => (x ? String(x.j?.error ?? x.r.status) : "network error");

/** Container: URL-selected profile, one draft, all fetches. Presentational pieces live in components/research. */
export function ResearchView({ profiles, categories, models, researchDisabled }: { profiles: Profile[]; categories: string[]; models: readonly string[]; researchDisabled: boolean }) {
  const router = useRouter();
  const sel = useSearchParams().get("p");
  const [list, setList] = useState(profiles);
  useEffect(() => setList(profiles), [profiles]);
  const selKey = sel ?? list[0]?.id ?? null;
  const isNew = selKey === NEW_ID;
  const current = !isNew && selKey ? list.find((p) => p.id === selKey) ?? null : null;
  const key = isNew ? NEW_ID : current?.id ?? null;

  const [saved, setSaved] = useState<Draft>(newDraft);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>(null);
  const [fail, setFail] = useState<Fail | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewState>(idle);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<{ id: string | null } | null>(null);
  const [stale, setStale] = useState(false);
  const dirty = !same(draft, saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const loaded = useRef<{ key: string | null; at: number | null }>({ key: null, at: null });
  const skipReset = useRef<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);

  // Load the selected profile into the draft. Same profile + dirty: never overwrite, just flag it.
  useEffect(() => {
    if (!key) return;
    const d = current ? fromProfile(current) : newDraft();
    if (loaded.current.key === key) {
      if (dirtyRef.current) { if (current && current.updatedAt !== loaded.current.at) setStale(true); return; }
    } else if (skipReset.current !== key) {
      setErrors({}); setStatus(null); setPreview(idle); setStale(false); setPending(null);
    }
    skipReset.current = null;
    loaded.current = { key, at: current?.updatedAt ?? null };
    setSaved(d); setDraft(d);
  }, [key, current?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (id: string | null) => { setPending(null); router.push(id ? `/research?p=${id}` : "/research", { scroll: false }); };
  const nav = (id: string) => { if (id === key) return; dirty ? setPending({ id }) : go(id); };
  const rejected = (j: { issues?: { path: (string | number)[]; message: string }[] } | null) => { if (j?.issues) { setErrors(mapIssues(j.issues)); return true; } return false; };

  const save = async () => {
    if (!dirty || blocker(draft) || busy) return;
    setBusy(true); setStatus(null); setFail(null);
    const res = await call(isNew ? "POST" : "PUT", isNew ? API : `${API}/${current!.id}`, buildInput(draft));
    setBusy(false);
    if (res?.r.status === 409) { setErrors({ name: "A profile with this name already exists" }); return; }
    if (res?.r.status === 400 && rejected(res.j)) return;
    if (!res?.r.ok) { setFail({ text: `Save failed: ${why(res)}`, retry: save }); return; }
    const p = toProfile(res.j), d = fromProfile(p);
    setErrors({}); setList((l) => [...l.filter((x) => x.id !== p.id), p].sort(byName));
    loaded.current = { key: p.id, at: p.updatedAt };
    if (isNew) { skipReset.current = p.id; router.replace(`/research?p=${p.id}`, { scroll: false }); }
    setSaved(d); setDraft(d); setStatus({ tone: "up", text: `saved ${hm(Date.now())}` });
    router.refresh();
  };

  const toggle = async (p: Profile) => {
    const put = (x: Profile) => setList((l) => l.map((y) => (y.id === x.id ? x : y)));
    put({ ...p, enabled: !p.enabled });
    const res = await call("PUT", `${API}/${p.id}`, buildInput({ ...fromProfile(p), enabled: !p.enabled }));
    if (!res?.r.ok) { put(p); setFail({ text: `Toggle failed: ${why(res)}`, retry: () => toggle(p) }); return; }
    put(toProfile(res.j));
    router.refresh();
  };

  const run = async () => {
    if (!current || dirty || busy || researchDisabled) return;
    setBusy(true); setStatus(null); setFail(null);
    const res = await call("POST", `${API}/${current.id}/run`);
    setBusy(false);
    if (res?.r.status !== 202) { setFail({ text: `Run failed: ${why(res)}`, retry: run }); return; }
    const n = (res.j?.queued ?? []).length;
    setStatus(n ? { tone: "up", text: `Queued ${n} market${n === 1 ? "" : "s"}`, fleet: true } : { tone: "muted", text: "0 markets matched — nothing queued" });
    router.refresh();
  };

  const remove = async () => {
    if (!current) return;
    const rest = list.filter((x) => x.id !== current.id), i = list.findIndex((x) => x.id === current.id);
    setBusy(true);
    const res = await call("DELETE", `${API}/${current.id}`);
    setBusy(false);
    if (!res?.r.ok) { setFail({ text: `Delete failed: ${why(res)}`, retry: remove }); return; }
    setList(rest); setSaved(draft);
    router.replace(rest.length ? `/research?p=${(rest[i] ?? rest[i - 1])!.id}` : "/research", { scroll: false });
    router.refresh();
  };

  const runPreview = async () => {
    if (preview.state === "loading") return;
    const f = toFilter(draft.filter);
    const hint = Object.keys(f).filter((k) => k !== "sort" && k !== "limit").slice(0, 2);
    setPreview((p) => ({ ...p, state: "loading", limit: f.limit ?? 10 }));
    const res = await call("POST", `${API}/preview`, { filter: f });
    if (res?.r.status === 400 && rejected(res.j)) { setPreview((p) => ({ ...p, state: "error", error: "Invalid filter — see the fields above" })); return; }
    if (!res?.r.ok) { setPreview((p) => ({ ...p, state: "error", error: `Preview failed: ${why(res)}` })); return; }
    const matches = res.j as Match[];
    setPreview({ state: "idle", matches, at: Date.now(), limit: f.limit ?? 10, hint: hint.length ? `${hint.join(" and ")} ${hint.length > 1 ? "are" : "is"} set.` : "" });
    if (current) setCounts((c) => ({ ...c, [current.id]: matches.length }));
  };

  // Latest handlers for the window listeners below.
  const h = useRef({ runPreview, run, nav, key });
  h.current = { runPreview, run, nav, key };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inInput(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n") { e.preventDefault(); h.current.nav(NEW_ID); }
      else if (e.key === "p" && h.current.key) void h.current.runPreview();
      else if (e.key === "x") void h.current.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Dirty: swallow the g-nav chord (it would drop the draft) and warn on tab close.
  useEffect(() => {
    if (!dirty) return;
    const g = (e: KeyboardEvent) => { if (e.key === "g" && !inInput(e) && !e.metaKey && !e.ctrlKey && !e.altKey) { e.stopPropagation(); setPending({ id: null }); } };
    const unload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("keydown", g, true);
    window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener("keydown", g, true); window.removeEventListener("beforeunload", unload); };
  }, [dirty]);
  useEffect(() => { editor.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: "center" }); }, [errors]);

  const rows: Profile[] = isNew ? [{ id: NEW_ID, name: "(new)", enabled: false, filter: {} as Profile["filter"], steering: draft.steering, everyMin: null, lastRunAt: null, updatedAt: 0 }, ...list] : list;
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const unplaced = Object.entries(errors).filter(([k]) => k === "" || !/^(name|everyMin|filter\.|steering\.)/.test(k)).map(([, v]) => v);

  const empty = !rows.length;
  return (
    <div className={pg.stack}>
      <div className="page-h">
        <h1>Research</h1>
        <div className="r"><Button variant="primary" onClick={() => nav(NEW_ID)}>+ New profile <kbd>n</kbd></Button></div>
      </div>
      {researchDisabled && (
        <div className={`${ui.bar} ${ui.barWarn}`} role="status"><span className="warn">Research is disabled on this server. Profiles can be edited but nothing will run.</span></div>
      )}
      {fail && <ErrorBar message={fail.text} onRetry={fail.retry && (() => { setFail(null); fail.retry!(); })} onDismiss={() => setFail(null)} />}
      {empty ? (
        <Panel title="Profiles" label="profiles">
          <EmptyState text="No research profiles yet" action={<Button onClick={() => nav(NEW_ID)}>Create profile</Button>} />
          <p className={pg.line} style={{ color: "var(--muted)", paddingTop: 0 }}>Profiles pick which markets to research and how. The screener shortlist keeps running either way.</p>
        </Panel>
      ) : (
      <div className={cx.split}>
        <Panel title="Profiles" label="profiles" right={<span className="n">{list.length}</span>} className={cx.list}>
          <Flat><ProfileTable profiles={rows} selected={key} onSelect={nav} onToggle={toggle} lockedId={dirty ? key : null} matchCounts={counts} onOpen={() => document.querySelector<HTMLInputElement>('[aria-label="profile name"]')?.focus()} /></Flat>
        </Panel>
        <div className={cx.work} ref={editor} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void save(); } }}>
          {!key ? (
            <p className={pg.hint}>Profiles pick which markets to research and how. The screener shortlist keeps running either way.</p>
          ) : (
            <>
              {pending && (
                <div className={`${ui.bar} ${ui.barWarn}`} role="alert">
                  <span className="warn">Discard unsaved changes?</span>
                  <Button size="sm" onClick={() => { const id = pending.id; setDraft(saved); setErrors({}); id ? go(id) : setPending(null); }}>Discard</Button>
                  <Button size="sm" onClick={() => setPending(null)}>Keep editing</Button>
                </div>
              )}
              {stale && (
                <div className={`${ui.bar} ${ui.barWarn}`} role="alert">
                  <span className="warn">Changed elsewhere — reload</span>
                  <Button size="sm" onClick={() => { const d = current ? fromProfile(current) : newDraft(); loaded.current.at = current?.updatedAt ?? null; setSaved(d); setDraft(d); setStale(false); }}>Reload</Button>
                </div>
              )}
              <ProfileToolbar key={key} name={draft.name} enabled={draft.enabled} nameError={errors.name} dirty={dirty} isNew={isNew} blocker={blocker(draft)} busy={busy} runDisabled={researchDisabled} status={status}
                onName={(name) => set({ name })} onEnabled={(enabled) => set({ enabled })} onPreview={runPreview} onRun={run} onSave={save} onDelete={remove} />
              {unplaced.map((m, i) => <ErrorBar key={i} message={m} />)}
              <FormGroup title="Filter" dirty={!same(draft.filter, saved.filter)}>
                <FilterForm value={draft.filter} onChange={(filter) => set({ filter })} errors={scope(errors, "filter.")} categories={categories} />
              </FormGroup>
              <FormGroup title="Steering" dirty={!same(draft.steering, saved.steering)}>
                <SteeringForm idp="ed" value={draft.steering} onChange={(steering) => set({ steering })} errors={scope(errors, "steering.")} models={models} />
              </FormGroup>
              <FormGroup title="Schedule" dirty={draft.every !== saved.every || draft.unit !== saved.unit}>
                <ScheduleForm every={draft.every} unit={draft.unit} enabled={draft.enabled} lastRunAt={current?.lastRunAt ?? null} error={errors.everyMin} onChange={set} />
              </FormGroup>
              <PreviewPane p={preview} onPreview={runPreview} />
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
