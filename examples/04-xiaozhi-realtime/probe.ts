// 不用设备探一遍实时语音：合成一句提问 → 解成 16k PCM → 按实时节奏推上去 → 看识别、回复、音频、用量。
import { concatPcm, OpusDecoder, pcmToBytes } from "@voxengine/audio";
import { doubaoTts } from "@voxengine/providers/doubao";
import type { RealtimeEvent } from "@voxengine/providers";
import type { AudioFormat } from "@voxengine/protocol";
import { createModel, env } from "./model";

const PCM_16K: AudioFormat = { codec: "pcm16", sampleRate: 16000, channels: 1, frameMs: 20 };
const question = "你好，用一句话介绍一下你自己。";

const tts = doubaoTts({ apiKey: env("DOUBAO_API_KEY"), speaker: env("DOUBAO_TTS_SPEAKER", "zh_female_vv_uranus_bigtts") });
const decoder = new OpusDecoder(16000);
const parts: Int16Array[] = [];
for await (const chunk of tts.synthesize(question, AbortSignal.timeout(15_000))) {
  if (chunk.type === "audio") parts.push(decoder.decode(chunk.frame.data));
}
decoder.destroy();
const speech = concatPcm([concatPcm(parts), new Int16Array(16000 * 3)]);
console.log(`提问音频 ${Math.round(parts.reduce((n, p) => n + p.length, 0) / 16)} ms，后面跟 3 秒静音`);

const started = Date.now();
const at = () => `${Date.now() - started} ms`;
let finished!: () => void;
const done = new Promise<void>((resolve) => (finished = resolve));
let reply = "";
let audioMs = 0;
let firstAudio = "";

const connection = createModel().connect({ instructions: "回答一两句话。", tools: [], input: PCM_16K }, (event: RealtimeEvent) => {
  switch (event.type) {
    case "speech.started":
      console.log(`${at()} 服务端听到开口`);
      break;
    case "transcript":
      console.log(`${at()} 识别 ✓「${event.text}」`);
      break;
    case "reply.text":
      reply += event.text;
      break;
    case "audio":
      firstAudio ||= at();
      audioMs += event.frame.format.frameMs;
      break;
    case "reply.done":
      console.log(`${at()} 回复 ✓「${reply}」首个音频 ${firstAudio}，共 ${audioMs} ms 音频`);
      console.log("等用量（服务端常常晚十几秒才给）…");
      break;
    case "usage":
      console.log(`${at()} 用量 ✓ ${event.usage.map((u) => `${u.unit}=${u.units}`).join(" ")}`);
      finished();
      break;
    case "error":
      console.log(`${at()} 出错 ${event.error.message}`);
      if (!event.recoverable) finished();
      break;
  }
});

const samples = 320;
for (let i = 0; i < speech.length; i += samples) {
  connection.pushAudio({ format: PCM_16K, seq: i / samples, data: pcmToBytes(speech.subarray(i, i + samples)) });
  await Bun.sleep(20);
}
await Promise.race([done, Bun.sleep(30_000)]);
connection.close();
await Bun.sleep(500);
process.exit(0);
