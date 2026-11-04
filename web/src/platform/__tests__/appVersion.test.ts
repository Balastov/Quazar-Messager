import { expect, it } from "vitest";
import { isNewerVersion } from "../appVersion";

it.each([
  ["0.20.3", "0.20.2", true],
  ["0.20.10", "0.20.9", true],
  ["0.21.0", "0.20.9", true],
  ["1.0.0", "0.99.99", true],
  ["0.20.2", "0.20.2", false],
  ["0.20.1", "0.20.2", false],
  ["0.19.99", "0.20.0", false],
  ["not a version", "0.20.2", false],
  ["0.21.0", "unknown", false],
  ["0.21.0-beta.1", "0.20.2", false],
  ["0.21", "0.20.2", false],
])("only recognizes newer published versions: %s vs %s", (candidate, current, expected) => {
  expect(isNewerVersion(candidate, current)).toBe(expected);
});
