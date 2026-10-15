import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useFetch } from "../api";
import { type Ctx, Err } from "../ui";

const flat = (o: unknown, p = ""): string[] =>
  o && typeof o === "object" && !Array.isArray(o)
    ? Object.entries(o).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k))
    : [`${p} = ${JSON.stringify(o)}`];

export function Settings({ ctx }: { ctx: Ctx }) {
  const [scroll, setScroll] = useState(0);
  const { data, error } = useFetch<unknown>("/api/settings", ctx.tick);
  const lines = data ? flat(data) : [];
  useInput(
    (ch, key) => {
      if (ch === "j" || key.downArrow) setScroll((s) => Math.min(s + 1, Math.max(0, lines.length - 1)));
      else if (ch === "k" || key.upArrow) setScroll((s) => Math.max(0, s - 1));
    },
    { isActive: ctx.active },
  );
  if (!data) return <Err error={error} />;
  return (
    <Box flexDirection="column">
      {lines.slice(scroll, scroll + ctx.h).map((l, i) => <Text key={i} wrap="truncate">  {l}</Text>)}
    </Box>
  );
}
