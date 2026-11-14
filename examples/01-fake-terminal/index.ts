// 不用硬件、不用密钥：假终端说一句话，回声 Runtime 播回来，再中途打断一次。
import { FakeTerminal } from "@voxengine/adapters/fake";
import { createEngine } from "@voxengine/core";
import { echoRuntime } from "@voxengine/runtimes/echo";

const engine = createEngine({ profile: { runtime: echoRuntime(), idleTimeoutMs: 500 } });

engine.on((event) => {
  if (event.type === "error") console.error("error", event.error);
  else console.log("event   ", event.type, summary(event));
});

const terminal = new FakeTerminal(engine);
terminal.send({ type: "session.start", trigger: "wake" });

terminal.say(10);
await terminal.waitFor("play.stop");

terminal.say(50);
await terminal.waitFor("play.start");
await Bun.sleep(200);
terminal.send({ type: "speech.start" });
await terminal.waitFor("play.stop");

await terminal.waitFor("session.ended");
console.log("\n下行消息：", terminal.received.filter((m) => m.type !== "audio.out").map((m) => m.type).join(" → "));
console.log("下行音频帧：", terminal.count("audio.out"));
engine.close();

function summary(event: object): string {
  const { type, ...rest } = event as Record<string, unknown>;
  return JSON.stringify(rest);
}
