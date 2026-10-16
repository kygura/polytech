import { read } from "../../../lib/jobs";
import { FleetView } from "./FleetView";

export default async function FleetPage() {
  const r = await read.readDeps();
  return <FleetView data={await read.fleet(r)} now={r.now()} />;
}
