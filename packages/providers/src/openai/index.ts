import type { ToolSpec, Usage } from "@voxengine/protocol";
import { ensureOk, lines } from "../lines.ts";
import type { ChatChunk, ChatMessage, LanguageModel, ToolCall } from "../types.ts";

export interface OpenAIChatOptions {
  apiKey: string;
  model: string;
  /** 默认 OpenAI。方舟：https://ark.cn-beijing.volces.com/api/v3 */
  baseUrl?: string;
  temperature?: number;
  /** 厂商自己的字段，原样并进请求体，如方舟的 `{ thinking: { type: "disabled" } }`。 */
  extraBody?: Record<string, unknown>;
  name?: string;
}

/** 任何 OpenAI Chat Completions 兼容接口：OpenAI、方舟（豆包）、DeepSeek、Ollama…… */
export function openaiChat(options: OpenAIChatOptions): LanguageModel {
  const name = options.name ?? "openai";
  const url = `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;

  return {
    name,
    async *generate(messages, tools, signal) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: options.model,
          messages: messages.map(toWire),
          tools: tools.length > 0 ? tools.map(toWireTool) : undefined,
          temperature: options.temperature,
          stream: true,
          stream_options: { include_usage: true },
          ...options.extraBody,
        }),
        signal,
      });
      await ensureOk(response, `${name} 对话`);

      const calls = new Map<number, ToolCall>();
      for await (const line of lines(response.body!)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") break;
        const event = JSON.parse(data) as StreamEvent;
        const delta = event.choices?.[0]?.delta;
        if (delta?.content) yield { type: "text", text: delta.content } satisfies ChatChunk;
        for (const part of delta?.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
          call.id ||= part.id ?? "";
          call.name += part.function?.name ?? "";
          call.arguments += part.function?.arguments ?? "";
          calls.set(part.index, call);
        }
        if (event.usage) yield { type: "usage", usage: toUsage(name, options.model, event.usage) };
      }
      for (const call of calls.values()) {
        yield { type: "tool_call", call: { ...call, id: call.id || crypto.randomUUID(), arguments: call.arguments || "{}" } };
      }
    },
  };
}

interface StreamEvent {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toWire(message: ChatMessage) {
  switch (message.role) {
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    default:
      return message;
  }
}

function toWireTool(tool: ToolSpec) {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

function toUsage(provider: string, model: string, usage: NonNullable<StreamEvent["usage"]>): Usage[] {
  return [
    { provider, model, unit: "tokens_in", units: usage.prompt_tokens ?? 0, estimated: false },
    { provider, model, unit: "tokens_out", units: usage.completion_tokens ?? 0, estimated: false },
  ];
}
