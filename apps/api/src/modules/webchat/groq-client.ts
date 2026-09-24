// A thin, dependency-free client for Groq's OpenAI-compatible chat completions endpoint. Plain
// fetch rather than an SDK: one call, one shape, and nothing else in this codebase reaches for an
// HTTP client library either.

import type { GroqMessage, GroqToolCall } from "./webchat-session.ts";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface GroqCompletion {
  content: string | null;
  toolCalls: GroqToolCall[];
}

function groqModel(): string {
  return process.env["GROQ_MODEL"] ?? "openai/gpt-oss-120b";
}

export async function callGroq(messages: GroqMessage[], tools: GroqTool[]): Promise<GroqCompletion> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set -- see .env.example.");
  }

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: groqModel(),
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq request failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    choices?: { message: { content: string | null; tool_calls?: GroqToolCall[] } }[];
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("Groq returned no choices.");

  return { content: message.content, toolCalls: message.tool_calls ?? [] };
}
