// 小智设备（如 BOX-3）连 ws://<本机>:<PORT>/chat：唤醒后说话，每 3 秒把听到的播回去。
// 用来验证握手、下行节奏、打断，不需要任何密钥。
import { logEvents, startGateway } from "@voxengine/gateway";
import { echoRuntime } from "@voxengine/runtimes/echo";

const gateway = startGateway({
  port: Number(process.env.PORT ?? 18989),
  hostname: "0.0.0.0",
  profile: { runtime: echoRuntime({ turnMs: 3000 }), idleTimeoutMs: 20_000 },
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
logEvents(gateway.engine);
console.log(`VoxEngine 网关已启动：ws://0.0.0.0:${gateway.port}/chat`);

process.on("SIGINT", async () => {
  await gateway.stop();
  process.exit(0);
});
