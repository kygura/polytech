import { ALLOWED_MODELS } from "@pm/core";
import { schema as s } from "@pm/db";
import { listProfiles, read } from "../../../lib/jobs";
import { researchDisabled } from "../../../lib/public";
import { toProfile } from "../../../components/research/steering";
import { ResearchView } from "./ResearchView";

export default async function ResearchPage() {
  const r = await read.readDeps();
  const [profiles, cats, disabled] = await Promise.all([listProfiles(r.db), r.db.selectDistinct({ c: s.markets.category }).from(s.markets), researchDisabled()]);
  return <ResearchView profiles={profiles.map(toProfile)} categories={cats.flatMap((x) => (x.c ? [x.c] : [])).sort()} models={ALLOWED_MODELS} researchDisabled={disabled} />;
}
