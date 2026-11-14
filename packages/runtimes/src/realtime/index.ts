import type { Runtime } from "@voxengine/core";
import type { RealtimeModel } from "@voxengine/providers";
import { SentenceSplitter } from "../cascade/sentences.ts";
import { invoke } from "../tools.ts";

export interface RealtimeRuntimeOptions {
  model: RealtimeModel;
}

/**
 * 端到端语音：判句、识别、生成、合成都在厂商那边，这里只把它的事件对到核心的轮次上。
 * 工具由这里执行（不交给厂商），字幕按句发（厂商的文字增量太碎）。
 *
 * 打断后厂商那边的上下文仍是生成的全文；厂商有截断接口时由 Provider 自己处理。
 */
export function realtimeRuntime(options: RealtimeRuntimeOptions): Runtime {
  const { model } = options;

  return {
    name: "realtime",
    open(ctx) {
      if (model.format.codec !== ctx.output.codec || model.format.sampleRate !== ctx.output.sampleRate) {
        const want = `${ctx.output.codec}/${ctx.output.sampleRate}`;
        const got = `${model.format.codec}/${model.format.sampleRate}`;
        queueMicrotask(() => ctx.emit({ type: "error", error: new Error(`终端下行要 ${want}，${model.name} 输出 ${got}`) }));
      }

      /** 核心已经知道这一轮开始了（发过 speech.ended，或核心自己调了 endOfSpeech / pushText）。 */
      let turnOpen = false;
      /** 被打断后丢掉这段回复的剩余事件，直到下一段回复开始。 */
      let dropping = false;
      let splitter = new SentenceSplitter();

      const openTurn = () => {
        if (turnOpen) return;
        turnOpen = true;
        ctx.emit({ type: "speech.ended" });
      };
      const say = (sentences: string[]) => sentences.forEach((text) => ctx.emit({ type: "reply.text", text }));

      const connection = model.connect(
        { instructions: ctx.instructions, tools: ctx.tools, input: ctx.input },
        (event) => {
          switch (event.type) {
            case "speech.started":
              ctx.emit({ type: "speech.started" });
              break;
            case "transcript":
              if (!event.final || !event.text) break;
              openTurn();
              ctx.emit({ type: "transcript", text: event.text, final: true });
              break;
            case "reply.started":
              dropping = false;
              splitter = new SentenceSplitter();
              openTurn();
              break;
            case "reply.text":
              if (!dropping) say(splitter.push(event.text));
              break;
            case "audio":
              if (!dropping) ctx.emit({ type: "audio", frame: event.frame });
              break;
            case "reply.done":
              if (dropping) break;
              say(splitter.flush());
              turnOpen = false;
              ctx.emit({ type: "reply.done" });
              break;
            case "tool_calls":
              // 被打断了也要交回结果，否则厂商一直等着这一轮。
              void Promise.all(
                event.calls.map(async (call) => ({ callId: call.id, content: await invoke(ctx.tools, call) })),
              ).then((results) => connection.submitToolResults(results));
              break;
            case "usage":
              for (const usage of event.usage) ctx.emit({ type: "usage", usage });
              break;
            case "error":
              ctx.emit({ type: "error", error: event.error, recoverable: event.recoverable });
              if (event.recoverable && turnOpen) {
                turnOpen = false;
                ctx.emit({ type: "reply.done" });
              }
              break;
          }
        },
      );

      return {
        capabilities: { liveTranscripts: model.liveTranscripts, tools: true, bargeIn: true },
        pushAudio(frame) {
          connection.pushAudio(frame);
        },
        pushText(text) {
          turnOpen = true;
          if (connection.sendText) return connection.sendText(text);
          turnOpen = false;
          ctx.emit({ type: "error", error: new Error(`${model.name} 不支持文字输入`), recoverable: true });
          ctx.emit({ type: "reply.done" });
        },
        endOfSpeech() {
          turnOpen = true;
          if (connection.commit()) return;
          turnOpen = false;
          ctx.emit({ type: "reply.done" });
        },
        interrupt() {
          dropping = true;
          turnOpen = false;
          connection.cancel();
        },
        close() {
          connection.close();
        },
      };
    },
  };
}
