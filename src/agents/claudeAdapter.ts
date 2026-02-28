import { BaseCliAgentAdapter } from "./agentAdapter.js";
import type { AgentType } from "../types.js";

export class ClaudeAdapter extends BaseCliAgentAdapter {
  readonly type: AgentType = "claude";

  protected async buildStartArgs(sessionRef: string | null, fresh: boolean): Promise<string[]> {
    if (fresh) {
      return [];
    }
    if (sessionRef) {
      return ["--resume", sessionRef];
    }
    return ["--continue"];
  }
}
