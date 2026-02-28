import { BaseCliAgentAdapter } from "./agentAdapter.js";
import type { AgentType } from "../types.js";

export class CodexAdapter extends BaseCliAgentAdapter {
  readonly type: AgentType = "codex";

  protected async buildStartArgs(sessionRef: string | null, fresh: boolean): Promise<string[]> {
    if (fresh) {
      return [];
    }
    if (sessionRef) {
      return ["resume", sessionRef];
    }
    return ["resume", "--last"];
  }
}
