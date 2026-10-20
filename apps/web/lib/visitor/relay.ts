import type { EnvironmentConfig } from "@polymarket/client";

/** SDK environment whose REST hosts go through our relay (app/api/pm), so the browser never calls Polymarket directly. */
export async function relayEnvironment(origin = location.origin): Promise<EnvironmentConfig> {
  const { forkEnvironmentConfig } = await import("@polymarket/client");
  const rest = (host: string) => ({ rest: `${origin}/api/pm/${host}` });
  return forkEnvironmentConfig({ name: "relay", clob: rest("clob"), gamma: rest("gamma"), data: rest("data"), relayer: rest("relayer") });
}
