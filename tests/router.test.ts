import { describe, expect, it } from "vitest";
import { routeTextInput } from "../src/core/router.js";

describe("routeTextInput", () => {
  it("switches only for /claude", () => {
    expect(routeTextInput("/claude")).toEqual({ type: "switch_agent", agent: "claude" });
  });

  it("switches only for /codex", () => {
    expect(routeTextInput("/codex")).toEqual({ type: "switch_agent", agent: "codex" });
  });

  it("passes through other slash commands unchanged", () => {
    expect(routeTextInput("/clear")).toEqual({ type: "passthrough", payload: "/clear" });
    expect(routeTextInput("/compact now")).toEqual({ type: "passthrough", payload: "/compact now" });
  });

  it("routes normal text as message", () => {
    expect(routeTextInput("hello world")).toEqual({ type: "message", payload: "hello world" });
  });
});
