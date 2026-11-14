import { OggOpusReader, opusPacketMs } from "@voxengine/audio";
import type { AudioFormat, AudioFrame, Usage } from "@voxengine/protocol";
import type { RealtimeConnection, RealtimeEvent, RealtimeModel, RealtimeOptions, ToolCall } from "../types.ts";
import { DOUBAO_TTS_FORMAT } from "./tts.ts";

/** 下行格式：和单向合成一样，Opus 24 kHz 单声道 20 ms。 */
export const DOUBAO_REALTIME_FORMAT: AudioFormat = DOUBAO_TTS_FORMAT;

export interface SocketHandlers {
  open(): void;
  message(text: string): void;
  close(code: number, reason: string): void;
}

export interface Socket {
  send(text: string): void;
  close(): void;
}

export interface DoubaoRealtimeOptions {
  /** 新控制台 API Key。实时对话不支持旧控制台 App ID + Access Key。 */
  apiKey: string;
  /** 实时对话音色，如 zh_female_vv_jupiter_bigtts。合成 2.0 的音色在这里不能用。 */
  voice?: string;
  model?: string;
  url?: string;
  /** 多久没收到上行音频就告诉服务端关麦，否则服务端超时不再回应。默认 800 ms。 */
  muteIdleMs?: number;
  /** 原样放进 session.create 的 extension，如 `{ dialog: { extra: { enable_music: true } } }`。 */
  extension?: Record<string, unknown>;
  /** 换掉 WebSocket。测试用。 */
  socket?: (url: string, headers: Record<string, string>, on: SocketHandlers) => Socket;
}

/** 会话建好之前最多攒这么多毫秒上行音频，建好后补发。 */
const MAX_PENDING_MS = 3000;
/** 关会话后等服务端回 session.closed（顺带收迟到的用量）的最长时间。 */
const CLOSE_WAIT_MS = 2000;

/**
 * 豆包端到端实时语音 3.0（JSON 事件，OpenAI Realtime 风格）。
 *
 * 和协议对不上的地方都在这里抹平：音频 delta 不带 id，只能归到最近一段回复；
 * 服务端自己判出用户插话时，被截断的回复没有 audio.done，要在 transcription.started 时补结束；
 * response.done 只带用量、不带 id，还可能晚十几秒，不拿它判断回复结束。
 * 服务端上下文存的是生成的全文，不是用户听到的部分，协议也没有截断事件。
 */
export function doubaoRealtime(options: DoubaoRealtimeOptions): RealtimeModel {
  const url = options.url ?? "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";
  const model = options.model ?? "1.2.6.1";
  const muteIdleMs = options.muteIdleMs ?? 800;
  const openSocket = options.socket ?? webSocket;

  return {
    name: "doubao-realtime",
    format: DOUBAO_REALTIME_FORMAT,
    liveTranscripts: true,
    connect(config: RealtimeOptions, emit: (event: RealtimeEvent) => void): RealtimeConnection {
      const inputType = inputFormat(config.input);
      let ready = false;
      let closing = false;
      let closed = false;
      let pending: AudioFrame[] = [];
      let pendingMs = 0;
      let muted = false;
      let muteTimer: ReturnType<typeof setTimeout> | undefined;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      /** 服务端已发 transcription.started，还没出结果。 */
      let hearing = false;
      /** 正在下发的回复；undefined 表示没有，残余音频丢掉。 */
      let reply: { id: string; reader: OggOpusReader } | undefined;
      /** 已结束（说完、被截断、被取消）的回复。它迟到的文字不能把它重新开起来。 */
      const ended = new Set<string>();
      let seq = 0;

      const socket = openSocket(url, { "X-Api-Key": options.apiKey }, {
        open() {
          if (!inputType) return;
          send({
            type: "session.create",
            session: {
              model,
              instructions: config.instructions,
              ...(config.tools.length > 0 && {
                tools: config.tools.map((t) => ({ type: "function", ...t })),
              }),
              audio: {
                input: { format: { type: inputType, rate: config.input.sampleRate } },
                output: {
                  format: { type: "ogg_opus", rate: DOUBAO_REALTIME_FORMAT.sampleRate },
                  ...(options.voice && { voice: options.voice }),
                },
              },
            },
            ...(options.extension && { extension: options.extension }),
          });
        },
        message(text) {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(text);
          } catch {
            return;
          }
          onServer(event);
        },
        close(code, reason) {
          closed = true;
          clearTimeout(muteTimer);
          clearTimeout(closeTimer);
          if (!closing) emit({ type: "error", error: new Error(`豆包实时连接断开 ${code} ${reason}`) });
        },
      });

      if (!inputType) {
        queueMicrotask(() =>
          emit({ type: "error", error: new Error(`豆包实时收不了 ${config.input.codec}/${config.input.sampleRate}`) }),
        );
      }

      function send(event: Record<string, unknown>): void {
        if (!closed) socket.send(JSON.stringify(event));
      }

      function append(frame: AudioFrame): void {
        if (muted) {
          send({ type: "input_audio_unmute.commit" });
          muted = false;
        }
        send({ type: "input_audio_buffer.append", audio: Buffer.from(frame.data).toString("base64") });
        clearTimeout(muteTimer);
        muteTimer = setTimeout(() => {
          send({ type: "input_audio_mute.commit" });
          muted = true;
        }, muteIdleMs);
      }

      /** 返回这段回复是否还在下发。 */
      function startReply(id: string): boolean {
        if (reply?.id === id) return true;
        if (ended.has(id)) return false;
        reply = { id, reader: new OggOpusReader() };
        emit({ type: "reply.started" });
        return true;
      }

      function endReply(notify: boolean): void {
        if (!reply) return;
        ended.add(reply.id);
        reply = undefined;
        if (notify) emit({ type: "reply.done" });
      }

      function onServer(event: Record<string, unknown>): void {
        const responseId = String(event.response_id ?? "");
        switch (event.type) {
          case "session.created":
            ready = true;
            for (const frame of pending) append(frame);
            pending = [];
            break;
          case "conversation.item.input_audio_transcription.started":
            hearing = true;
            endReply(true);
            emit({ type: "speech.started" });
            break;
          case "conversation.item.input_audio_transcription.completed":
            hearing = false;
            emit({ type: "transcript", text: String(event.text ?? event.transcript ?? ""), final: true });
            break;
          case "conversation.item.input_audio_transcription.failed":
          case "input_audio_buffer.committed":
            hearing = false;
            break;
          case "response.output_text.delta":
            if (!responseId || typeof event.delta !== "string") break;
            if (startReply(responseId)) emit({ type: "reply.text", text: event.delta });
            break;
          case "response.output_audio.started":
            if (responseId) startReply(responseId);
            break;
          case "response.output_audio.delta":
            if (reply && typeof event.delta === "string") {
              for (const packet of reply.reader.push(Buffer.from(event.delta, "base64"))) {
                const format = { ...DOUBAO_REALTIME_FORMAT, frameMs: opusPacketMs(packet) };
                emit({ type: "audio", frame: { format, seq: seq++, data: packet } });
              }
            }
            break;
          case "response.output_audio.done":
            if (reply?.id === responseId) endReply(true);
            break;
          case "response.canceled":
            endReply(true);
            break;
          case "response.done":
            emit({ type: "usage", usage: readUsage(event, model) });
            break;
          case "response.function_call_arguments.done": {
            const calls = readCalls(event);
            if (calls.length > 0) emit({ type: "tool_calls", calls });
            break;
          }
          case "session.closed":
            socket.close();
            break;
          case "error": {
            const error = (event.error ?? event) as { code?: unknown; message?: unknown };
            emit({ type: "error", error: new Error(`豆包实时出错 ${error.code ?? ""} ${error.message ?? ""}`), recoverable: true });
            break;
          }
        }
      }

      return {
        pushAudio(frame) {
          if (closing || !inputType) return;
          if (ready) return append(frame);
          pending.push(frame);
          pendingMs += frame.format.frameMs;
          while (pendingMs > MAX_PENDING_MS) pendingMs -= pending.shift()!.format.frameMs;
        },
        commit() {
          if (!hearing) return false;
          send({ type: "input_audio_buffer.commit" });
          return true;
        },
        cancel() {
          if (!reply) return;
          endReply(false);
          send({ type: "response.cancel" });
        },
        submitToolResults(results) {
          send({
            type: "conversation.item.create",
            items: results.map((r) => ({ call_id: r.callId, role: "tool", content: [{ type: "input_text", text: r.content }] })),
          });
        },
        close() {
          if (closing) return;
          closing = true;
          endReply(false);
          clearTimeout(muteTimer);
          if (!ready) return socket.close();
          send({ type: "session.close" });
          closeTimer = setTimeout(() => socket.close(), CLOSE_WAIT_MS);
        },
      };
    },
  };
}

function inputFormat(format: AudioFormat): "speech_opus" | "pcm" | undefined {
  if (format.sampleRate !== 16000 || format.channels !== 1) return undefined;
  return format.codec === "opus" ? "speech_opus" : "pcm";
}

function readCalls(event: Record<string, unknown>): ToolCall[] {
  const items = Array.isArray(event.items) ? (event.items as Record<string, unknown>[]) : [];
  return items
    .filter((item) => typeof item.call_id === "string" && typeof item.name === "string")
    .map((item) => ({
      id: item.call_id as string,
      name: item.name as string,
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
    }));
}

type Counts = Record<string, unknown> | undefined;

function readUsage(event: Record<string, unknown>, model: string): Usage[] {
  const usage = ((event.response as Counts)?.usage ?? {}) as Record<string, unknown>;
  const input = usage.input_token_details as Counts;
  const cached = input?.cached_tokens_details as Counts;
  const output = usage.output_token_details as Counts;
  const units: [string, unknown][] = [
    ["tokens_in_text", input?.text_tokens],
    ["tokens_in_audio", input?.audio_tokens],
    ["tokens_in_text_cached", cached?.text_tokens],
    ["tokens_in_audio_cached", cached?.audio_tokens],
    ["tokens_out_text", output?.text_tokens],
    ["tokens_out_audio", output?.audio_tokens],
  ];
  return units
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([unit, n]) => ({ provider: "doubao-realtime", model, unit, units: n, estimated: false }));
}

/** 默认用 Bun 的 WebSocket：它支持握手请求头。 */
function webSocket(url: string, headers: Record<string, string>, on: SocketHandlers): Socket {
  const ws = new WebSocket(url, { headers });
  ws.onopen = () => on.open();
  ws.onmessage = (e) => {
    if (typeof e.data === "string") on.message(e.data);
  };
  ws.onclose = (e) => on.close(e.code, e.reason);
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: () => ws.close(),
  };
}
