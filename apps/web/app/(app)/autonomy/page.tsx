import { read } from "../../../lib/jobs";
import { AutonomyView } from "./AutonomyView";

export default async function AutonomyPage() {
  return <AutonomyView data={await read.autonomy(await read.readDeps())} />;
}
