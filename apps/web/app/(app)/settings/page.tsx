import { DEFAULT_MODELS } from "@pm/agents";
import { read } from "../../../lib/jobs";
import { SettingsView } from "./SettingsView";

export default async function SettingsPage() {
  const r = await read.readDeps();
  const [settings, cats] = await Promise.all([read.settingsGet(r), r.db.markets.all().then((ms) => [...new Set(ms.map((m) => m.category))].map((c) => ({ c })))]);
  return <SettingsView initial={settings} categories={cats.flatMap((x) => (x.c ? [x.c] : [])).sort()} defaultModels={DEFAULT_MODELS} />;
}
