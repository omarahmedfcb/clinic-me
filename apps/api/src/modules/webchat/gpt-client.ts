// A thin, dependency-free client for OpenAI's Responses API. Plain fetch rather than the SDK: one
// call, one shape, and nothing else in this codebase reaches for an HTTP client library either.
//
// The Responses API, not Chat Completions, on purpose:
// - previous_response_id lets us hand OpenAI a pointer to the prior turn instead of resending the
//   whole conversation transcript ourselves on every call. It does NOT reduce what OpenAI bills --
//   the full chained context is still charged as input tokens on every call, same as if we had
//   resent it by hand (OpenAI's own migration guide says so explicitly). What it buys is a far
//   smaller request from us, a lot less code, and no hand-maintained message array to get subtly
//   wrong -- which is what most of the earlier Groq bugs actually were.
// - Structured ("strict") function schemas let OpenAI validate a tool call's arguments against our
//   JSON Schema before we ever see it, closing off the exact failure class Groq kept producing
//   ("tool choice required, but model did not call a tool" / a call for a tool that wasn't offered).

const OPENAI_URL = "https://api.openai.com/v1/responses";

export interface GptTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

export interface GptFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface GptCompletion {
  id: string;
  outputText: string | null;
  toolCalls: GptFunctionCall[];
}

export type GptInputItem =
  | { role: "user"; content: string }
  | { type: "function_call_output"; call_id: string; output: string };

function gptModel(): string {
  return process.env["OPENAI_MODEL"] ?? "gpt-5-nano";
}

/**
 * "minimal" answers fastest, but OpenAI's own guidance is that a nano-tier model can occasionally
 * burn its whole token budget on hidden reasoning and return nothing useful on "minimal" for a task
 * that requires any judgment -- and this flow has to interpret a patient's free-text date or pick
 * out which household member they mean, not just format text. "low" is the safer default; override
 * with OPENAI_REASONING_EFFORT if gpt-5.4-nano needs a different value.
 */
function reasoningEffort(): string {
  return process.env["OPENAI_REASONING_EFFORT"] ?? "low";
}

export async function callGpt(params: {
  input: GptInputItem[];
  tools: GptTool[];
  instructions: string;
  previousResponseId?: string;
}): Promise<GptCompletion> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set -- see .env.example.");
  }

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: gptModel(),
      instructions: params.instructions,
      input: params.input,
      tools: params.tools,
      tool_choice: "auto",
      previous_response_id: params.previousResponseId,
      // Reasoning models (the whole GPT-5 family, nano included) reject temperature/top_p outright
      // -- this `reasoning` object is the parameter they take instead.
      reasoning: { effort: reasoningEffort() },
      text: { verbosity: "low" },
      // A reasoning model spends part of this budget on hidden reasoning before it writes anything
      // visible; too low a ceiling here comes back as a *silent* empty reply (finish reason
      // "length"), not an error -- there is nothing to catch. Generous on purpose: nano's output
      // price makes the difference between 512 and 2048 tokens immaterial.
      max_output_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    id: string;
    output?: Array<
      | { type: "message"; role: "assistant"; content: Array<{ type: string; text?: string }> }
      | { type: "function_call"; call_id: string; name: string; arguments: string }
      | { type: string }
    >;
  };

  const toolCalls: GptFunctionCall[] = [];
  let outputText: string | null = null;

  for (const item of data.output ?? []) {
    if (item.type === "function_call" && "call_id" in item) {
      toolCalls.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
    } else if (item.type === "message" && "content" in item) {
      const text = item.content.find((part) => part.type === "output_text")?.text;
      if (text) outputText = text;
    }
  }

  return { id: data.id, outputText, toolCalls };
}
