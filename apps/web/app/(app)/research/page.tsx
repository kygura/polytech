import { ALLOWED_MODELS } from "@pm/core";
import { listProfiles, read } from "../../../lib/jobs";
import { researchDisabled } from "../../../lib/public";
import { toProfile } from "../../../components/research/steering";
import { ResearchTabs } from "./ResearchTabs";

export default async function ResearchPage() {
  const r = await read.readDeps();
  const [profiles, cats, disabled] = await Promise.all([listProfiles(r.db), r.db.markets.distinct("category").then((cs) => cs.map((c) => ({ c }))), researchDisabled()]);
  return <ResearchTabs profiles={profiles.map(toProfile)} categories={cats.flatMap((x) => (x.c ? [x.c] : [])).sort()} models={ALLOWED_MODELS} researchDisabled={disabled} />;
}
