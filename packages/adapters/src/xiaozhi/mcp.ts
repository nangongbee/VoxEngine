import type { ToolSpec } from "@voxengine/protocol";

const MAX_LIST_PAGES = 8;

interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 网关作为设备 MCP 的客户端（JSON-RPC 走 `{type:"mcp", payload}`）。
 * 固件只接受数字 id；`annotations.audience` 含 "user" 的工具（重启、升级）不交给模型。
 */
export class DeviceMcp {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly send: (payload: unknown) => void,
    private readonly timeoutMs = 5000,
  ) {}

  async listTools(): Promise<ToolSpec[]> {
    await this.request("initialize", { capabilities: {} });
    const tools: ToolSpec[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = (await this.request("tools/list", { cursor })) as { tools?: unknown[]; nextCursor?: string };
      for (const raw of result?.tools ?? []) {
        const tool = readTool(raw);
        if (tool) tools.push(tool);
      }
      cursor = result?.nextCursor ?? "";
      if (!cursor) return tools;
    }
    throw new Error("MCP tools/list 分页过多");
  }

  async call(name: string, args: unknown): Promise<string> {
    const result = (await this.request("tools/call", { name, arguments: args ?? {} })) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (result?.isError) throw new Error(text || "设备工具执行失败");
    return text;
  }

  handle(payload: unknown): void {
    const msg = (typeof payload === "string" ? safeParse(payload) : payload) as
      | { id?: unknown; result?: unknown; error?: { message?: string } }
      | undefined;
    if (typeof msg?.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP 请求失败"));
    else pending.resolve(msg.result);
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP 已关闭"));
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP 已关闭"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
}

function readTool(raw: unknown): ToolSpec | undefined {
  const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { audience?: unknown } };
  if (typeof tool?.name !== "string") return undefined;
  const audience = tool.annotations?.audience;
  if (Array.isArray(audience) && audience.includes("user")) return undefined;
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
