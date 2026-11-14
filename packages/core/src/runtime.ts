import type { AudioFormat, AudioFrame, RuntimeCapabilities, ToolSpec, Usage } from "@voxengine/protocol";

export type { RuntimeCapabilities } from "@voxengine/protocol";

/** 核心包过一层的工具：只回文字；超时、取消、要播的音频都在核心处理掉了。失败时抛错。 */
export interface RuntimeTool extends ToolSpec {
  invoke(args: unknown): Promise<string>;
}

export interface RuntimeContext {
  sessionId: string;
  instructions: string;
  tools: RuntimeTool[];
  /** 终端上行格式。Runtime 收不了时自己报错。 */
  input: AudioFormat;
  /** 终端下行格式。Runtime 输出的帧要是这个格式。 */
  output: AudioFormat;
  /** 识别出的一句话算不算数（按 Profile.acceptUtterance）。不算数的不要开新一轮、不要回答。 */
  acceptUtterance(text: string): boolean;
  emit(event: RuntimeEvent): void;
}

/**
 * `speech.started` 是「用户开始说一句算数的话」，不是「听到声音」：判断标准由 Runtime 定
 * （听到人声就算，或识别出字、过了 acceptUtterance 才算）。核心收到它就可能打断播放。
 * Runtime 自己判出用户说完时发 `speech.ended`，之后才能发这一轮的回复。
 * 核心调过 `endOfSpeech()` 的那一轮，不用再发。
 */
export type RuntimeEvent =
  | { type: "speech.started" }
  | { type: "speech.ended" }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "reply.text"; text: string }
  | { type: "audio"; frame: AudioFrame }
  | { type: "reply.done" }
  | { type: "usage"; usage: Usage }
  /** recoverable：这一轮失败，会话继续；否则结束会话。 */
  | { type: "error"; error: Error; recoverable?: boolean };

export interface RuntimeSession {
  /** 核心每次用时都重新读：混合 Runtime 降级后能力会变。 */
  readonly capabilities: RuntimeCapabilities;
  pushAudio(frame: AudioFrame): void;
  pushText(text: string): void;
  /** 终端判定用户说完（设备 VAD 或 manual 模式松键）。 */
  endOfSpeech(): void;
  /** 停止当前回复。playedMs 是用户实际听到的时长，上下文只保留这部分。 */
  interrupt(playedMs: number): void;
  close(): void;
}

export interface Runtime {
  readonly name: string;
  /** 同步返回，返回前不要 emit；要连厂商的话在内部连，失败发 `error`。 */
  open(ctx: RuntimeContext): RuntimeSession;
}
