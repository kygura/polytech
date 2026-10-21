import { DEFAULT_MODELS } from "@pm/agents";
import { schema as s } from "@pm/db";
import { read } from "../../../lib/jobs";
import { SettingsView } from "./SettingsView";

export default async function SettingsPage() {
  const r = await read.readDeps();
  const [settings, cats] = await Promise.all([read.settingsGet(r), r.db.selectDistinct({ c: s.markets.category }).from(s.markets)]);
  return <SettingsView initial={settings} categories={cats.flatMap((x) => (x.c ? [x.c] : [])).sort()} defaultModels={DEFAULT_MODELS} />;
}
