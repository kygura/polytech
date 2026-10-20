import { Skeleton } from "../../components/Skeleton";
import { Panel } from "../../components/ui";

export default function Loading() {
  return (
    <Panel label="loading">
      <Skeleton rows={8} />
    </Panel>
  );
}
