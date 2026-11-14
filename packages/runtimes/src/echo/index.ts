import type { Runtime } from "@voxengine/core";
import type { AudioFrame } from "@voxengine/protocol";

export interface EchoOptions {
  /** 听满这么多毫秒就当用户说完，自己切一轮。终端不报 speech.end 时用。 */
  turnMs?: number;
}

/**
 * 回声：用户说完就把听到的音频原样播回去，文字原样回显。
 * 不连任何厂商，用来跑通链路和测试。要求终端上下行格式相同。
 */
export function echoRuntime(options: EchoOptions = {}): Runtime {
  return {
    name: "echo",
    open(ctx) {
      let heard: AudioFrame[] = [];
      let heardMs = 0;
      let seq = 0;
      /** 回放播完的时刻。之前听到的多半是自己的声音（设备边播边收音），不收。 */
      let replayingUntil = 0;

      const reply = (text: string, frames: AudioFrame[]) => {
        ctx.emit({ type: "reply.text", text });
        for (const frame of frames) ctx.emit({ type: "audio", frame: { ...frame, seq: seq++ } });
        ctx.emit({ type: "reply.done" });
        replayingUntil = Date.now() + frames.reduce((ms, f) => ms + f.format.frameMs, 0);
      };

      const replayHeard = () => {
        const frames = heard;
        heard = [];
        heardMs = 0;
        ctx.emit({ type: "transcript", text: `[${frames.length} 帧音频]`, final: true });
        reply(`回放 ${frames.length} 帧`, frames);
      };

      return {
        capabilities: { liveTranscripts: true, tools: false, bargeIn: true },
        pushAudio(frame) {
          if (Date.now() < replayingUntil) return;
          heard.push(frame);
          heardMs += frame.format.frameMs;
          if (options.turnMs && heardMs >= options.turnMs) {
            ctx.emit({ type: "speech.ended" });
            replayHeard();
          }
        },
        pushText(text) {
          reply(text, []);
        },
        endOfSpeech: replayHeard,
        interrupt() {
          heard = [];
          heardMs = 0;
          replayingUntil = 0;
        },
        close() {
          heard = [];
        },
      };
    },
  };
}
