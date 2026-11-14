import { bytesToPcm, OpusDecoder } from "@voxengine/audio";
import type { Runtime } from "@voxengine/core";
import {
  energyVad,
  type ChatMessage,
  type LanguageModel,
  type SpeechToText,
  type TextToSpeech,
  type ToolCall,
  type VoiceActivityDetector,
} from "@voxengine/providers";
import type { AudioFrame } from "@voxengine/protocol";
import { invoke } from "../tools.ts";
import { SentenceSplitter } from "./sentences.ts";
import { TurnTaker, type EndpointOptions } from "./turn-taker.ts";

export type { EndpointOptions } from "./turn-taker.ts";

export interface CascadeOptions {
  stt: SpeechToText;
  llm: LanguageModel;
  tts: TextToSpeech;
  /** 每场会话新建一个。默认能量 VAD。 */
  vad?: () => VoiceActivityDetector;
  endpoint?: EndpointOptions;
  /**
   * 什么时候算用户开口（会打断播放）。
   * transcript（默认）：一句说完、识别出字、过了 Profile.acceptUtterance 才算。慢半拍，但喇叭回声不会打断自己。
   * voice：VAD 听到人声就算。打断快，只适合回声很小的设备。
   */
  startOn?: "voice" | "transcript";
  /** 一轮里最多几次模型调用（含工具后的追问）。默认 3。 */
  maxRounds?: number;
  /** 保留多少条历史（不含系统提示）。默认 20。 */
  maxHistory?: number;
}

/** 播出去的一句：文字和已经下发的音频时长，用来算「用户实际听到了哪些」。 */
interface Spoken {
  text: string;
  ms: number;
}

interface Turn {
  abort: AbortController;
  spoken: Spoken[];
  /** 这一轮最后写进历史的助手消息；打断时改成用户听到的部分。 */
  reply?: { role: "assistant"; content: string };
}

/**
 * 级联：VAD 切句 → 识别 → 模型（流式）→ 按句合成。
 * 新的一句话会取消正在进行的一轮；打断时历史里只留用户听到的部分。
 */
export function cascadeRuntime(options: CascadeOptions): Runtime {
  const { stt, llm, tts } = options;
  const maxRounds = options.maxRounds ?? 3;
  const maxHistory = options.maxHistory ?? 20;

  return {
    name: "cascade",
    open(ctx) {
      if (tts.format.codec !== ctx.output.codec || tts.format.sampleRate !== ctx.output.sampleRate) {
        const want = `${ctx.output.codec}/${ctx.output.sampleRate}`;
        const got = `${tts.format.codec}/${tts.format.sampleRate}`;
        queueMicrotask(() => ctx.emit({ type: "error", error: new Error(`终端下行要 ${want}，${tts.name} 输出 ${got}`) }));
      }

      const startOn = options.startOn ?? "transcript";
      const system: ChatMessage[] = ctx.instructions ? [{ role: "system", content: ctx.instructions }] : [];
      let history: ChatMessage[] = [];
      let current: Turn | undefined;
      /** 核心已为下一句开了一轮（调过 endOfSpeech）；这句不算数时要发 reply.done 让核心回到听。 */
      let announced = false;
      /** transcript 模式下还在识别、没决定算不算数的句子。 */
      const hearing = new Set<AbortController>();
      const decoder = ctx.input.codec === "opus" ? new OpusDecoder(ctx.input.sampleRate as 16000) : undefined;
      const turnTaker = new TurnTaker(
        options.vad?.() ?? energyVad(),
        ctx.input.sampleRate,
        {
          onSpeechStart: () => {
            if (startOn === "voice") ctx.emit({ type: "speech.started" });
          },
          onUtterance: (pcm) => {
            const turnOpen = announced;
            announced = false;
            if (startOn === "transcript") return void hear(pcm, turnOpen);
            ctx.emit({ type: "speech.ended" });
            start(async (signal) => {
              const text = await recognize(pcm, signal);
              if (!text || signal.aborted || !ctx.acceptUtterance(text)) return "";
              ctx.emit({ type: "transcript", text, final: true });
              return text;
            });
          },
        },
        options.endpoint,
      );

      const recognize = async (pcm: Int16Array, signal: AbortSignal): Promise<string> => {
        const { text, usage } = await stt.transcribe({ pcm, sampleRate: ctx.input.sampleRate }, signal);
        for (const u of usage) ctx.emit({ type: "usage", usage: u });
        return text.trim();
      };

      /** 先识别，算数了才告诉核心「用户开口了」：喇叭回声识别出来多半是空的或碎片。 */
      async function hear(pcm: Int16Array, turnOpen: boolean): Promise<void> {
        const abort = new AbortController();
        hearing.add(abort);
        try {
          const text = await recognize(pcm, abort.signal);
          if (abort.signal.aborted) return;
          if (!text || !ctx.acceptUtterance(text)) {
            if (turnOpen) ctx.emit({ type: "reply.done" });
            return;
          }
          ctx.emit({ type: "speech.started" });
          ctx.emit({ type: "speech.ended" });
          ctx.emit({ type: "transcript", text, final: true });
          start(async () => text);
        } catch (err) {
          if (abort.signal.aborted) return;
          ctx.emit({ type: "error", error: err as Error, recoverable: true });
          if (turnOpen) ctx.emit({ type: "reply.done" });
        } finally {
          hearing.delete(abort);
        }
      }

      function start(input: (signal: AbortSignal) => Promise<string>): void {
        current?.abort.abort();
        const turn: Turn = { abort: new AbortController(), spoken: [] };
        current = turn;
        run(turn, input).then(
          () => {
            if (!turn.abort.signal.aborted) ctx.emit({ type: "reply.done" });
          },
          (err: Error) => {
            if (turn.abort.signal.aborted) return;
            ctx.emit({ type: "error", error: err, recoverable: true });
            ctx.emit({ type: "reply.done" });
          },
        );
      }

      async function run(turn: Turn, input: (signal: AbortSignal) => Promise<string>): Promise<void> {
        const signal = turn.abort.signal;
        const text = await input(signal);
        if (!text || signal.aborted) return;
        remember({ role: "user", content: text });

        let speaking = Promise.resolve();
        const say = (sentence: string) => {
          speaking = speaking.then(() => speak(turn, sentence));
        };

        for (let round = 0; round < maxRounds; round++) {
          const splitter = new SentenceSplitter();
          const calls: ToolCall[] = [];
          let reply = "";
          const tools = round < maxRounds - 1 ? ctx.tools : [];
          for await (const chunk of llm.generate([...system, ...history], tools, signal)) {
            if (signal.aborted) return;
            if (chunk.type === "text") {
              reply += chunk.text;
              splitter.push(chunk.text).forEach(say);
            } else if (chunk.type === "tool_call") {
              calls.push(chunk.call);
            } else {
              for (const u of chunk.usage) ctx.emit({ type: "usage", usage: u });
            }
          }
          splitter.flush().forEach(say);

          if (calls.length === 0) {
            turn.reply = { role: "assistant", content: reply };
            remember(turn.reply);
            break;
          }
          remember({ role: "assistant", content: reply, toolCalls: calls });
          for (const call of calls) {
            remember({ role: "tool", toolCallId: call.id, content: await invoke(ctx.tools, call) });
          }
          if (signal.aborted) return;
        }
        await speaking;
      }

      async function speak(turn: Turn, sentence: string): Promise<void> {
        const signal = turn.abort.signal;
        if (signal.aborted) return;
        const spoken: Spoken = { text: sentence, ms: 0 };
        turn.spoken.push(spoken);
        ctx.emit({ type: "reply.text", text: sentence });
        for await (const chunk of tts.synthesize(sentence, signal)) {
          if (signal.aborted) return;
          if (chunk.type === "audio") {
            ctx.emit({ type: "audio", frame: chunk.frame });
            spoken.ms += chunk.frame.format.frameMs;
          } else {
            for (const u of chunk.usage) ctx.emit({ type: "usage", usage: u });
          }
        }
      }

      function remember(message: ChatMessage): void {
        history.push(message);
        history = trimHistory(history, maxHistory);
      }

      return {
        capabilities: { liveTranscripts: true, tools: true, bargeIn: true },
        pushAudio(frame) {
          const pcm = toPcm(frame, decoder);
          if (pcm) turnTaker.push(pcm, frame.format.frameMs);
        },
        pushText(text) {
          start(async () => text);
        },
        endOfSpeech() {
          announced = true;
          if (turnTaker.flush()) return;
          announced = false;
          ctx.emit({ type: "reply.done" });
        },
        interrupt(playedMs) {
          const turn = current;
          if (!turn) return;
          turn.abort.abort();
          const heard = heardText(turn.spoken, playedMs);
          const content = heard ? `${heard}……（被用户打断）` : "（还没说出口就被用户打断）";
          if (turn.reply) turn.reply.content = content;
          else remember({ role: "assistant", content });
        },
        close() {
          current?.abort.abort();
          for (const abort of hearing) abort.abort();
          decoder?.destroy();
        },
      };
    },
  };
}

/** 按已播时长，算出用户听到了哪些字。还没合成出音频的句子算没听到。 */
export function heardText(spoken: Spoken[], playedMs: number): string {
  let left = playedMs;
  let heard = "";
  for (const { text, ms } of spoken) {
    if (ms === 0) break;
    if (left >= ms) {
      heard += text;
      left -= ms;
      continue;
    }
    heard += text.slice(0, Math.floor((text.length * left) / ms));
    break;
  }
  return heard;
}

/** 只保留最近 max 条，并且从一条用户消息开始，免得工具结果没了对应的调用。 */
function trimHistory(history: ChatMessage[], max: number): ChatMessage[] {
  if (history.length <= max) return history;
  let start = history.length - max;
  while (start < history.length && history[start]!.role !== "user") start++;
  return history.slice(start);
}
function toPcm(frame: AudioFrame, decoder: OpusDecoder | undefined): Int16Array | undefined {
  if (frame.format.codec === "pcm16") return bytesToPcm(frame.data);
  try {
    return decoder?.decode(frame.data);
  } catch {
    return undefined;
  }
}
