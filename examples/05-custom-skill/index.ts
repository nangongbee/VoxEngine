// 小智设备连 ws://<本机>:<PORT>/chat：在示例 3、4 的基础上加一个讲故事工具。
// 故事放在 STORY_DIR（默认 ./stories），要求 24 kHz 单声道 Ogg Opus、20 ms 一帧，例如：
//   ffmpeg -i 小兔子.mp3 -ac 1 -ar 24000 -c:a libopus -b:a 48k -frame_duration 20 -application audio 小兔子.ogg
// RUNTIME=cascade 走级联（密钥见示例 3），默认走实时（密钥见示例 4）。
import { DOUBAO_REALTIME_FORMAT, DOUBAO_TTS_FORMAT } from "@voxengine/providers/doubao";
import { logEvents, startGateway } from "@voxengine/gateway";
import { cascadeRuntime } from "@voxengine/runtimes/cascade";
import { realtimeRuntime } from "@voxengine/runtimes/realtime";
import { createProviders } from "../03-xiaozhi-cascade/providers";
import { createModel } from "../04-xiaozhi-realtime/model";
import { storyTool } from "./story";

const cascade = process.env.RUNTIME === "cascade";

/** 去掉标点至少 3 个字（「换一个」能过，回声碎片「行」「嗯」过不了），而且不停在半截词上。 */
function meaningful(text: string): boolean {
  const bare = text.replace(/[\s，。！？、,.!?~～吧呀]/g, "");
  return bare.length >= 3 && !/(我想|那个|然后|就是|所以|还有|嗯|啊|呃)$/.test(bare) && !/[，,]$/.test(text.trim());
}

const gateway = startGateway({
  port: Number(process.env.PORT ?? 18989),
  hostname: "0.0.0.0",
  profile: {
    runtime: cascade ? cascadeRuntime(createProviders()) : realtimeRuntime({ model: createModel() }),
    instructions:
      process.env.INSTRUCTIONS ??
      "你是一个语音助手。回答口语化，一两句话说完。用户要听故事时调用 play_story，只说一句很短的确认。",
    tools: [storyTool(process.env.STORY_DIR ?? "./stories")],
    idleTimeoutMs: 30_000,
    bargeIn: process.env.BARGE_IN !== "0",
    // 播放中识别出来的话多半是喇叭回声或碎片：太短、像半句话就不算。规则归产品，这里只是参考。
    acceptUtterance: (text, { playing }) => !playing || meaningful(text),
    // 实时语音按连接时长计费：故事播 30 秒没人说话就关掉连接，故事照播；喊唤醒词会重开。级联没有长连接，不关。
    media: { releaseRuntimeMs: cascade ? 0 : 30_000 },
  },
  xiaozhi: { audioOut: cascade ? DOUBAO_TTS_FORMAT : DOUBAO_REALTIME_FORMAT },
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
logEvents(gateway.engine);
console.log(`VoxEngine 网关已启动：ws://0.0.0.0:${gateway.port}/chat`);

process.on("SIGINT", async () => {
  await gateway.stop();
  process.exit(0);
});
