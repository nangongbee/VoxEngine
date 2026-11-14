import type { AudioFormat, AudioFrame } from "./audio.ts";

export interface Capabilities {
  audioIn: AudioFormat;
  /** 设备能播的格式，按偏好排序；核心选第一个。 */
  audioOut: AudioFormat[];
  /** 设备自己会报 speech.start / speech.end。 */
  vad: boolean;
  /** 支持 listen.set wake_only。 */
  wakeOnly: boolean;
  /** 能被调工具，会发 tool.list。 */
  tools: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema。 */
  parameters: Record<string, unknown>;
}

export type SessionTrigger = "wake" | "button" | "text";
export type ListenMode = "auto" | "manual" | "realtime";

/** 终端 → 核心。 */
export type Uplink =
  | { type: "terminal.hello"; deviceId: string; capabilities: Capabilities }
  | { type: "tool.list"; tools: ToolSpec[] }
  | { type: "session.start"; trigger: SessionTrigger; wakeWord?: string; listenMode?: ListenMode }
  | { type: "audio.in"; frame: AudioFrame }
  | { type: "speech.start" }
  | { type: "speech.end" }
  | { type: "user.text"; text: string }
  | { type: "user.interrupt"; reason?: string }
  | { type: "tool.result"; callId: string; ok: boolean; content: string }
  | { type: "session.end"; reason?: string }
  | { type: "terminal.bye"; reason?: string };

export type ListenState = "open" | "closed" | "wake_only";
export type PlayKind = "reply" | "announce" | "media";
/** done：按设定播完就结束（如媒体 after: "end"），和没人说话的 idle 分开。 */
export type SessionEndReason = "idle" | "done" | "user" | "error" | "replaced" | "closed";

/** 核心 → 终端。 */
export type Downlink =
  | { type: "terminal.ready"; terminalId: string; audioOut: AudioFormat }
  | { type: "session.started"; sessionId: string }
  | { type: "listen.set"; state: ListenState }
  | { type: "play.start"; turnId: string; kind: PlayKind }
  | { type: "audio.out"; frame: AudioFrame }
  | { type: "caption"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "play.stop"; turnId: string; reason: "done" | "interrupted" }
  | { type: "tool.call"; callId: string; name: string; args: unknown }
  | { type: "session.ended"; sessionId: string; reason: SessionEndReason };
