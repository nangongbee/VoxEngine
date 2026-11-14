import type { SessionEndReason, SessionTrigger } from "./terminal.ts";

/** 一条用量。优先用厂商报的准确值；估算的必须标 estimated。 */
export interface Usage {
  provider: string;
  /** 如 tokens_in、tokens_out、audio_ms、tts_chars。 */
  unit: string;
  units: number;
  estimated: boolean;
  model?: string;
}

/** terminal：设备按键 / 唤醒词；speech：用户插话；text：设备发来文字。 */
export type InterruptSource = "terminal" | "speech" | "text";

/**
 * Runtime 自报的能力。核心和观察者按声明走，不按「它是级联还是实时」猜。
 * 用量准不准不在这里：每条 Usage 自己带 estimated。
 */
export interface RuntimeCapabilities {
  /** 回复途中就有用户转写（级联），还是整场结束后才有（端到端语音）。 */
  liveTranscripts: boolean;
  /** 一轮里能调工具。 */
  tools: boolean;
  /** 支持说到一半被打断。 */
  bargeIn: boolean;
}

/** live：这一轮当场出的；post_call：会话结束后厂商补的。 */
export type TranscriptAvailability = "live" | "post_call";

/** 工具失败的原因：自己抛错、超时、被打断或会话结束取消。 */
export type ToolFailure = "error" | "timeout" | "cancelled";

/** 核心发给观察者（存档、计费、日志）的事件，不发给终端。 */
export type EngineEvent =
  | { type: "terminal.ready"; deviceId: string; terminalId: string }
  | { type: "terminal.closed"; deviceId: string; terminalId: string; reason: SessionEndReason }
  | {
      type: "session.started";
      deviceId: string;
      sessionId: string;
      trigger: SessionTrigger;
      runtime: string;
      capabilities: RuntimeCapabilities;
    }
  | { type: "session.ended"; deviceId: string; sessionId: string; reason: SessionEndReason }
  | { type: "turn.started"; sessionId: string; turnId: string }
  | {
      type: "transcript";
      sessionId: string;
      turnId?: string;
      text: string;
      final: boolean;
      availability: TranscriptAvailability;
    }
  /** 识别出的一句话没过 acceptUtterance，被当成回声或碎片丢掉。 */
  | { type: "utterance.ignored"; sessionId: string; text: string; playing: boolean }
  | { type: "reply.text"; sessionId: string; turnId: string; text: string }
  /** 用户说完 → 首个音频包下发。 */
  | { type: "latency"; sessionId: string; turnId: string; firstAudioMs: number }
  | { type: "interrupt"; sessionId: string; turnId: string; playedMs: number; source: InterruptSource }
  | { type: "tool.called"; sessionId: string; callId: string; name: string; args: unknown }
  | {
      type: "tool.returned";
      sessionId: string;
      callId: string;
      ok: boolean;
      content: string;
      ms: number;
      failure?: ToolFailure;
    }
  | { type: "media.started"; sessionId: string; turnId: string; title?: string }
  /** 媒体下发进度；lagMs>0 表示下发落后墙钟（卡顿风险）。 */
  | { type: "media.progress"; sessionId: string; turnId: string; title?: string; sentMs: number; queuedMs: number; lagMs: number }
  | {
      type: "media.ended";
      sessionId: string;
      turnId: string;
      title?: string;
      playedMs: number;
      reason: "done" | "interrupted" | "error";
    }
  /** 长媒体播放中没人说话，提前关掉 Runtime（省钱、防厂商超时）；媒体照播，播完结束会话。 */
  | { type: "runtime.released"; sessionId: string }
  /** 释放后被唤醒、按键或文字打断，重开了一个 Runtime，回到听。 */
  | { type: "runtime.reopened"; sessionId: string }
  | { type: "usage"; sessionId: string; turnId?: string; usage: Usage }
  | { type: "error"; deviceId: string; sessionId?: string; error: Error };
