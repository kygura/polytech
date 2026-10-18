import { expect, it } from "vitest";
import { rolesOf } from "./fleet";

it("lists only roles present: built-ins first, custom roles next, judge last", () => {
  const agent = (role: string) => ({ role }) as never;
  const pods = [{ agents: [agent("judge"), agent("custom_x"), agent("source"), agent("rules")] }, { agents: [agent("news"), agent("custom_y")] }] as never;
  expect(rolesOf(pods)).toEqual(["rules", "source", "news", "custom_x", "custom_y", "judge"]);
});
