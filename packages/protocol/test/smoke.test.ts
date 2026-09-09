import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";

describe("protocol smoke", () => {
  it("exposes PROTOCOL_VERSION 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
