import type { RuntimeTool } from "@voxengine/core";
import type { ToolCall } from "@voxengine/providers";

/** 执行模型要的一个工具。出什么错都变成给模型看的文字，不抛。 */
export async function invoke(tools: RuntimeTool[], call: ToolCall): Promise<string> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return `没有这个工具：${call.name}`;
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return `参数不是合法 JSON：${call.arguments}`;
  }
  try {
    return await tool.invoke(args);
  } catch (err) {
    return `工具出错：${err instanceof Error ? err.message : String(err)}`;
  }
}
