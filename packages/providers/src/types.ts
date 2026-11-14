import type { AudioFormat, AudioFrame, ToolSpec, Usage } from "@voxengine/protocol";

/** 一段已经切好的用户语音：16 位单声道 PCM。 */
export interface Utterance {
  pcm: Int16Array;
  sampleRate: number;
}

export interface Transcript {
  text: string;
  usage: Usage[];
}

/**
 * 整句识别。切句（判断用户说完）由 Runtime 的 VAD 做，不由各家识别各判各的，
 * 这样换识别厂商不会改变「什么时候算说完」。
 */
export interface SpeechToText {
  readonly name: string;
  transcribe(utterance: Utterance, signal: AbortSignal): Promise<Transcript>;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 字符串，原样来自模型。 */
  arguments: string;
}

export type ChatChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: Usage[] };

/** 流式对话。文字边生成边吐，工具调用在完整拼好后吐。 */
export interface LanguageModel {
  readonly name: string;
  generate(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ChatChunk>;
}

export type SpeechChunk = { type: "audio"; frame: AudioFrame } | { type: "usage"; usage: Usage[] };

/** 一句文字 → 流式音频。输出格式要和终端下行格式一致。 */
export interface TextToSpeech {
  readonly name: string;
  /** 输出格式。frameMs 只是标称值，每帧以自己的 format 为准。 */
  readonly format: AudioFormat;
  synthesize(text: string, signal: AbortSignal): AsyncIterable<SpeechChunk>;
}

export interface RealtimeOptions {
  instructions: string;
  tools: ToolSpec[];
  /** 上行音频格式。厂商收不了就发致命 error。 */
  input: AudioFormat;
}

/**
 * 一段回复：`reply.started` → 若干 `reply.text`（增量）/ `audio` → `reply.done`。
 * 厂商自己判断用户插话、截断回复时，也要补一个 `reply.done`。
 */
export type RealtimeEvent =
  /** 服务端听到用户开口。可能正在回复，Runtime 据此打断。 */
  | { type: "speech.started" }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "reply.started" }
  | { type: "reply.text"; text: string }
  | { type: "audio"; frame: AudioFrame }
  | { type: "reply.done" }
  /** 同一批调用的结果要一起交回，模型才会接着说。 */
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "usage"; usage: Usage[] }
  /** recoverable：这一轮失败，连接还能用；否则连接已断。 */
  | { type: "error"; error: Error; recoverable?: boolean };

export interface ToolResult {
  callId: string;
  content: string;
}

export interface RealtimeConnection {
  pushAudio(frame: AudioFrame): void;
  /** 用户说完了（如松开按键）。返回 false 表示服务端没听到这句，不会有回复。 */
  commit(): boolean;
  /** 停掉正在说的回复。之后到的这段回复的残余音频，厂商实现负责丢掉。 */
  cancel(): void;
  submitToolResults(results: ToolResult[]): void;
  /** 文字提问。厂商不支持就不实现。 */
  sendText?(text: string): void;
  close(): void;
}

/** 端到端语音：一条长连接，音频进，音频、文字、工具调用出。 */
export interface RealtimeModel {
  readonly name: string;
  /** 下行音频格式。终端下行要配成这个。 */
  readonly format: AudioFormat;
  /** 回复途中就给用户转写；否则会话结束后才给。 */
  readonly liveTranscripts: boolean;
  /** 同步返回，内部连接；连不上发致命 error。 */
  connect(options: RealtimeOptions, emit: (event: RealtimeEvent) => void): RealtimeConnection;
}

/**
 * 逐帧判断有没有人声。只回答这一个问题；缓冲、切句、打断的策略在 Runtime 里。
 * 输入是 16 位单声道 PCM。
 */
export interface VoiceActivityDetector {
  readonly name: string;
  isSpeech(pcm: Int16Array, sampleRate: number): boolean;
}
