import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DIRS } from "../config.ts";
import type { Accounts } from "./accounts.ts";

export type Block = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/**
 * A fresh, tool-free Claude call with a JSON schema. No conversation history is resent,
 * which is what keeps batch work like B-roll cards affordable.
 */
export async function structured<T>(accounts: Accounts, params: { accountId: string; model: string; effort?: string; system: string; content: Block[]; schema: Record<string, unknown>; signal?: AbortSignal }) {
  const abort = new AbortController();
  params.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: params.content as never }, parent_tool_use_id: null } as SDKUserMessage;
  }
  const q = query({
    prompt: input(),
    options: {
      ...(await accounts.options(params.accountId)),
      cwd: DIRS.tmp,
      model: params.model,
      effort: params.effort as "medium" | undefined,
      tools: [],
      settingSources: [],
      persistSession: false,
      systemPrompt: params.system,
      abortController: abort,
      outputFormat: { type: "json_schema", schema: params.schema },
    },
  });
  for await (const m of q) {
    if (m.type === "result") {
      if (m.subtype !== "success") throw new Error(m.errors?.[0] ?? `Claude stopped: ${m.subtype}`);
      if (m.structured_output === undefined) throw new Error("Claude returned no structured answer.");
      return { value: m.structured_output as T, cost: m.total_cost_usd, usage: m.usage };
    }
  }
  throw new Error("Claude ended without an answer.");
}
