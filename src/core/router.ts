import type { AgentType } from "../types.js";

export type RouteDecision =
  | { type: "switch_agent"; agent: AgentType }
  | { type: "passthrough"; payload: string }
  | { type: "message"; payload: string };

export function routeTextInput(rawText: string): RouteDecision {
  const text = rawText.trim();
  if (text === "/claude") {
    return { type: "switch_agent", agent: "claude" };
  }
  if (text === "/codex") {
    return { type: "switch_agent", agent: "codex" };
  }
  if (text.startsWith("/")) {
    return { type: "passthrough", payload: rawText };
  }
  return { type: "message", payload: rawText };
}

export function otherAgent(agent: AgentType): AgentType {
  return agent === "claude" ? "codex" : "claude";
}
