import type { AudioFormat, AudioFrame, ToolSpec } from "@voxengine/protocol";

export interface Tool extends ToolSpec {
  /** 超时，默认用 Profile.toolTimeoutMs。 */
  timeoutMs?: number;
  /** 返回给模型的文字，或文字加一段要播的音频。失败就抛错，错误信息会回给模型。 */
  invoke(args: unknown, ctx: ToolContext): Promise<string | ToolOutput>;
}

export interface ToolContext {
  sessionId: string;
  deviceId: string;
  /** 设备下行格式。要播的音频必须是这个格式。 */
  output: AudioFormat;
  /** 用户打断、会话结束、超时时触发；reason 是 "interrupted" | "ended" | "timeout"。 */
  signal: AbortSignal;
}

export interface ToolOutput {
  /** 给模型看的文字。 */
  content: string;
  media?: Media;
}

/** 工具要播的一段音频。核心排在这一轮回复后面播。 */
export interface Media {
  /** 给日志和事件看的名字。 */
  title?: string;
  frames: AsyncIterable<AudioFrame>;
  /** 播放时用户说话能不能打断。默认跟 Profile.bargeIn。按键、唤醒词总能打断。 */
  bargeIn?: boolean;
  /** 播完以后：回到听（默认），或者结束会话。 */
  after?: "listen" | "end";
}
