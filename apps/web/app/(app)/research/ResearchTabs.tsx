"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Desk } from "../../../components/research/desk/Desk";
import { LiveRuns } from "../../../components/research/desk/LiveRuns";
import { useDesk } from "../../../components/research/desk/useDesk";
import type { Profile } from "../../../components/research/steering";
import { Tabs } from "../../../components/ui";
import { ResearchView } from "./ResearchView";

const PANEL = "research-tab";
type Tab = "desk" | "automate";

/** `?tab=desk|automate` (default desk; a bare `?p=` opens Automate). Both tabs stay mounted so the Desk queue and a profile draft survive switching. */
export function ResearchTabs({ profiles, categories, models, researchDisabled }: { profiles: Profile[]; categories: string[]; models: readonly string[]; researchDisabled: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const p = sp.get("p");
  const tab: Tab = sp.get("tab") === "automate" || (sp.get("tab") == null && p) ? "automate" : "desk";
  const desk = useDesk();
  const go = (t: string) => router.replace(`/research?tab=${t}${p ? `&p=${encodeURIComponent(p)}` : ""}`, { scroll: false });
  const running = desk.live.data?.runs.filter((r) => r.status === "running").length ?? 0;
  const tabs = <Tabs label="research" panelId={PANEL} active={tab} onChange={go} items={[{ id: "desk", label: "Desk", count: running + desk.queue.length || undefined }, { id: "automate", label: "Automate", count: profiles.length }]} />;
  const pane = (t: Tab) => (t === tab ? { id: PANEL, role: "tabpanel", "aria-labelledby": `${PANEL}-tab-${t}` } : { hidden: true });
  return (
    <>
      <div {...pane("desk")}><Desk tabs={tabs} desk={desk} researchDisabled={researchDisabled} /></div>
      <div {...pane("automate")}>
        <ResearchView profiles={profiles} categories={categories} models={models} researchDisabled={researchDisabled} tabs={tabs} active={tab === "automate"} live={<LiveRuns desk={desk} />} />
      </div>
    </>
  );
}
