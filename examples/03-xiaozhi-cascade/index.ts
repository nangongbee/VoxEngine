// 小智设备连 ws://<本机>:<PORT>/chat：豆包识别 → 方舟大模型 → 豆包合成，边想边说、可打断。
// 先跑 `bun probe.ts` 确认三个服务都通。设备喇叭回声大时用 BARGE_IN=0 关掉说话打断。
import { DOUBAO_TTS_FORMAT } from "@voxengine/providers/doubao";
import { logEvents, startGateway } from "@voxengine/gateway";
import { cascadeRuntime } from "@voxengine/runtimes/cascade";
import { createProviders } from "./providers";

const gateway = startGateway({
  port: Number(process.env.PORT ?? 18989),
  hostname: "0.0.0.0",
  profile: {
    runtime: cascadeRuntime(createProviders()),
    instructions: process.env.INSTRUCTIONS ?? "你是一个语音助手。回答口语化，一两句话说完，不用列表和表情。",
    idleTimeoutMs: 30_000,
    bargeIn: process.env.BARGE_IN !== "0",
  },
  xiaozhi: { audioOut: DOUBAO_TTS_FORMAT },
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
logEvents(gateway.engine);
console.log(`VoxEngine 网关已启动：ws://0.0.0.0:${gateway.port}/chat`);

process.on("SIGINT", async () => {
  await gateway.stop();
  process.exit(0);
});
