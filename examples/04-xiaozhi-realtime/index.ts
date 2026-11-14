// 小智设备连 ws://<本机>:<PORT>/chat：豆包端到端实时语音。和示例 3 只差 Runtime 这一行。
// 先跑 `bun probe.ts` 确认连得上。设备喇叭回声大时用 BARGE_IN=0 关掉说话打断。
import { DOUBAO_REALTIME_FORMAT } from "@voxengine/providers/doubao";
import { logEvents, startGateway } from "@voxengine/gateway";
import { realtimeRuntime } from "@voxengine/runtimes/realtime";
import { createModel } from "./model";

const gateway = startGateway({
  port: Number(process.env.PORT ?? 18989),
  hostname: "0.0.0.0",
  profile: {
    runtime: realtimeRuntime({ model: createModel() }),
    instructions: process.env.INSTRUCTIONS ?? "你是一个语音助手。回答口语化，一两句话说完，不用列表和表情。",
    idleTimeoutMs: 30_000,
    bargeIn: process.env.BARGE_IN !== "0",
  },
  xiaozhi: { audioOut: DOUBAO_REALTIME_FORMAT },
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
logEvents(gateway.engine);
console.log(`VoxEngine 网关已启动：ws://0.0.0.0:${gateway.port}/chat`);

process.on("SIGINT", async () => {
  await gateway.stop();
  process.exit(0);
});
