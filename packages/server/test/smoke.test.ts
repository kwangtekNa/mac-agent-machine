import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@mam/protocol";

describe("server smoke", () => {
  it("resolves @mam/protocol PROTOCOL_VERSION as 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
