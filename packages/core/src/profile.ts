import type { ToolSpec } from "@voxengine/protocol";
import type { Runtime } from "./runtime.ts";
import type { Tool } from "./tool.ts";

/** 一个助手：怎么说话、说什么、能做什么。由产品提供。 */
export interface Profile {
  runtime: Runtime;
  instructions?: string;
  tools?: Tool[];
  /** 设备列出的工具怎么交给模型：可以删、可以改描述。每场会话开始时调用。默认全部交出。 */
  deviceTools?(tools: ToolSpec[]): ToolSpec[];
  /** 工具默认超时。默认 10 秒。 */
  toolTimeoutMs?: number;
  /** 没人说话多久结束会话。0 表示不结束。默认 30 秒。 */
  idleTimeoutMs?: number;
  /** 助手说话时用户开口是否打断。默认是；Runtime 声明不支持时无效。设备回声大时关掉。 */
  bargeIn?: boolean;
  /**
   * 识别出一句话后，算不算用户真的说了话。playing：用户此刻正在听播放（回复或媒体），
   * 这时候多半是回声或碎片。默认非空就算。只有先拿到文字再决定回不回答的 Runtime（如级联）会问。
   */
  acceptUtterance?(text: string, ctx: { playing: boolean }): boolean;
  media?: MediaPolicy;
}

/** 工具返回的音频怎么播。 */
export interface MediaPolicy {
  /** 工具返回音频后，最多等模型的确认语多久；还没开口就直接播。默认 4 秒。 */
  waitMs?: number;
  /**
   * 媒体播放中多久没人说话就关掉 Runtime（省钱、防厂商长连接超时）。
   * 关掉后媒体照播，播完结束会话；被唤醒、按键或文字打断时重开一个 Runtime 回到听。0 表示不关。默认 0。
   */
  releaseRuntimeMs?: number;
}
