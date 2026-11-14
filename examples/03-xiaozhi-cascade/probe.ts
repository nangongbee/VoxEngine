// 不用设备，逐个探一遍厂商：合成一句 → 解码 → 识别回来对比 → 大模型流式回一句。
import { concatPcm, OpusDecoder } from "@voxengine/audio";
import { createProviders } from "./providers.ts";

const { stt, llm, tts } = createProviders();
const signal = AbortSignal.timeout(30_000);
const sentence = "你好，今天天气怎么样？";

let t = Date.now();
const decoder = new OpusDecoder(16000);
const pcm: Int16Array[] = [];
let firstPacketMs = 0;
for await (const chunk of tts.synthesize(sentence, signal)) {
  if (chunk.type !== "audio") continue;
  firstPacketMs ||= Date.now() - t;
  pcm.push(decoder.decode(chunk.frame.data));
}
decoder.destroy();
const audio = concatPcm(pcm);
console.log(`合成 ✓ 首包 ${firstPacketMs} ms，共 ${pcm.length} 包，${Math.round(audio.length / 16)} ms 音频`);

t = Date.now();
const { text } = await stt.transcribe({ pcm: audio, sampleRate: 16000 }, signal);
console.log(`识别 ✓ ${Date.now() - t} ms：「${text}」`);

t = Date.now();
let reply = "";
let firstTokenMs = 0;
for await (const chunk of llm.generate([{ role: "user", content: "用一句话打个招呼" }], [], signal)) {
  if (chunk.type === "text") {
    firstTokenMs ||= Date.now() - t;
    reply += chunk.text;
  }
}
console.log(`大模型 ✓ 首字 ${firstTokenMs} ms，全部 ${Date.now() - t} ms：「${reply}」`);
