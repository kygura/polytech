import { read } from "../../../lib/jobs";
import { AutonomyView } from "./AutonomyView";

export default async function AutonomyPage() {
  const r = await read.readDeps();
  const [data, proposals, settings] = await Promise.all([read.autonomy(r), read.proposals(r), read.settingsGet(r)]);
  return <AutonomyView data={data} proposals={proposals} settings={settings} />;
}
