import { expect, it } from "vitest";
import { PACKAGE } from "./index";

it("exports the package name", () => {
  expect(PACKAGE).toBe("@pm/agents");
});
