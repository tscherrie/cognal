import type { AgentType } from "../types.js";

export type RouteDecision =
  | { type: "switch_agent"; agent: AgentType }
  | { type: "passthrough"; payload: string }
  | { type: "message"; payload: string };

function normalizeSwitchCommand(rawText: string, botUsername?: string): string {
  const trimmed = rawText.trim();
  const firstSpace = trimmed.indexOf(" ");
  const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace);

  const match = firstToken.match(/^\/(claude|codex)(?:@([A-Za-z0-9_]+))?$/i);
  if (!match) {
    return rawText;
  }

  const target = match[1].toLowerCase();
  const mention = match[2];
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) {
    return rawText;
  }
  return `/${target}${rest}`;
}

export function routeTextInput(rawText: string, botUsername?: string): RouteDecision {
  const normalized = normalizeSwitchCommand(rawText, botUsername);
  const text = normalized.trim();
  if (text === "/claude") {
    return { type: "switch_agent", agent: "claude" };
  }
  if (text === "/codex") {
    return { type: "switch_agent", agent: "codex" };
  }
  if (text.startsWith("/")) {
    return { type: "passthrough", payload: normalized };
  }
  return { type: "message", payload: normalized };
}

export function otherAgent(agent: AgentType): AgentType {
  return agent === "claude" ? "codex" : "claude";
}
