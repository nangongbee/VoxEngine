import { afterEach, expect, test } from "bun:test";
import { FakeTerminal, PCM16_16K } from "@voxengine/adapters/fake";
import { createEngine, type Engine, type Profile, type Runtime, type RuntimeContext } from "@voxengine/core";
import type { EngineEvent } from "@voxengine/protocol";
import { echoRuntime } from "@voxengine/runtimes/echo";

let engine: Engine;
afterEach(() => engine?.close());

const caps = { liveTranscripts: true, tools: true, bargeIn: true };
const silent = { capabilities: caps, pushAudio() {}, pushText() {}, endOfSpeech() {}, interrupt() {}, close() {} };

function setup(profile: Partial<Profile> = {}) {
  engine = createEngine({ profile: { runtime: echoRuntime(), ...profile } });
  const events: EngineEvent[] = [];
  engine.on((event) => events.push(event));
  return { events, terminal: new FakeTerminal(engine) };
}

test("握手：hello → ready", async () => {
  const { terminal } = setup();
  const ready = await terminal.waitFor("terminal.ready");
  expect(ready.audioOut.codec).toBe("pcm16");
});

test("一轮对话：说完 → 开播 → 播完 → 回到听", async () => {
  const { terminal, events } = setup();
  terminal.send({ type: "session.start", trigger: "wake" });
  await terminal.waitFor("session.started");
  expect((await terminal.waitFor("listen.set")).state).toBe("open");

  terminal.say(5);
  await terminal.waitFor("caption");
  const start = await terminal.waitFor("play.start");
  const stop = await terminal.waitFor("play.stop");

  expect(stop).toMatchObject({ turnId: start.turnId, reason: "done" });
  expect(terminal.count("audio.out")).toBe(5);
  expect(events.map((e) => e.type)).toContain("latency");
});

test("打断：用户开口 → 停播，记下播了多久", async () => {
  const { terminal, events } = setup();
  terminal.send({ type: "session.start", trigger: "wake" });
  terminal.say(50);
  await terminal.waitFor("play.start");
  await Bun.sleep(100);

  terminal.send({ type: "speech.start" });
  const stop = await terminal.waitFor("play.stop");
  expect(stop.reason).toBe("interrupted");
  expect(terminal.count("audio.out")).toBeLessThan(50);

  const interrupt = events.find((e) => e.type === "interrupt");
  expect(interrupt?.type === "interrupt" && interrupt.playedMs).toBeGreaterThan(0);
});

test("播放中 Runtime 判出新的一句：打断旧的、开新一轮，不接在后面播", async () => {
  let emit: RuntimeContext["emit"] = () => {};
  const frame = { format: PCM16_16K, seq: 0, data: new Uint8Array(640) };
  const talker: Runtime = {
    name: "talker",
    open(ctx) {
      emit = ctx.emit;
      return silent;
    },
  };
  const { terminal, events } = setup({ runtime: talker });
  terminal.send({ type: "session.start", trigger: "wake" });
  await terminal.waitFor("session.started");

  emit({ type: "speech.ended" });
  for (let i = 0; i < 50; i++) emit({ type: "audio", frame });
  const first = await terminal.waitFor("play.start");

  emit({ type: "speech.ended" });
  expect(await terminal.waitFor("play.stop")).toMatchObject({ turnId: first.turnId, reason: "interrupted" });
  expect(events.find((e) => e.type === "interrupt")).toMatchObject({ source: "speech" });
  expect(events.filter((e) => e.type === "turn.started")).toHaveLength(2);
});

test("关掉插话时，用户开口不打断", async () => {
  const { terminal } = setup({ bargeIn: false });
  terminal.send({ type: "session.start", trigger: "wake" });
  terminal.say(5);
  await terminal.waitFor("play.start");
  terminal.send({ type: "speech.start" });
  expect((await terminal.waitFor("play.stop")).reason).toBe("done");
});

test("Runtime 声明不支持打断时，用户开口不打断", async () => {
  const echo = echoRuntime();
  const noBargeIn: Runtime = {
    name: "no-barge-in",
    open: (ctx) => ({ ...echo.open(ctx), capabilities: { ...caps, bargeIn: false } }),
  };
  const { terminal } = setup({ runtime: noBargeIn });
  terminal.send({ type: "session.start", trigger: "wake" });
  terminal.say(5);
  await terminal.waitFor("play.start");
  terminal.send({ type: "speech.start" });
  expect((await terminal.waitFor("play.stop")).reason).toBe("done");
});

test("会话开始事件带上 Runtime 名字和能力", async () => {
  const { terminal, events } = setup();
  terminal.send({ type: "session.start", trigger: "wake" });
  await terminal.waitFor("session.started");
  expect(events.find((e) => e.type === "session.started")).toMatchObject({
    runtime: "echo",
    capabilities: { bargeIn: true, tools: false },
  });
});

test("会话结束后补来的转写照样发给观察者，标 post_call，不再下发字幕", async () => {
  let emit: RuntimeContext["emit"] = () => {};
  const late: Runtime = {
    name: "late-transcript",
    open(ctx) {
      emit = ctx.emit;
      return { ...silent, capabilities: { ...caps, liveTranscripts: false } };
    },
  };
  const { terminal, events } = setup({ runtime: late });
  terminal.send({ type: "session.start", trigger: "wake" });
  await terminal.waitFor("session.started");
  terminal.send({ type: "session.end" });
  await terminal.waitFor("session.ended");

  emit({ type: "transcript", text: "你好", final: true });
  emit({ type: "audio", frame: { format: PCM16_16K, seq: 0, data: new Uint8Array(640) } });
  expect(events.find((e) => e.type === "transcript")).toMatchObject({ text: "你好", availability: "post_call" });
  expect(terminal.count("caption")).toBe(0);
  expect(terminal.count("audio.out")).toBe(0);
});

test("文字输入不需要先 session.start", async () => {
  const { terminal } = setup();
  terminal.send({ type: "user.text", text: "你好" });
  await terminal.waitFor("session.started");
  expect(await terminal.waitFor("caption")).toMatchObject({ role: "assistant", text: "你好" });
});

test("空闲超时结束会话，终端仍在线", async () => {
  const { terminal } = setup({ idleTimeoutMs: 50 });
  terminal.send({ type: "session.start", trigger: "wake" });
  expect((await terminal.waitFor("session.ended")).reason).toBe("idle");

  terminal.send({ type: "session.start", trigger: "button" });
  await terminal.waitFor("session.started");
});

test("同一设备重复上线，旧的被顶掉", async () => {
  const { terminal: first } = setup();
  first.send({ type: "session.start", trigger: "wake" });
  await first.waitFor("session.started");

  const second = new FakeTerminal(engine);
  await second.waitFor("terminal.ready");
  expect((await first.waitFor("session.ended")).reason).toBe("replaced");
});

test("设备工具：tool.call → tool.result 回到 Runtime", async () => {
  let answer: Promise<string> | undefined;
  const toolCaller: Runtime = {
    name: "tool-caller",
    open: (ctx) => ({
      ...silent,
      pushText() {
        answer = ctx.tools.find((t) => t.name === "set_volume")!.invoke({ level: 3 });
      },
    }),
  };
  const { terminal, events } = setup({ runtime: toolCaller });
  terminal.send({
    type: "tool.list",
    tools: [{ name: "set_volume", description: "调音量", parameters: { type: "object" } }],
  });
  terminal.send({ type: "user.text", text: "小声点" });

  const call = await terminal.waitFor("tool.call");
  expect(call).toMatchObject({ name: "set_volume", args: { level: 3 } });
  terminal.send({ type: "tool.result", callId: call.callId, ok: true, content: "音量 3" });

  expect(await answer).toBe("音量 3");
  expect(events.some((e) => e.type === "tool.returned" && e.ok)).toBe(true);
});
