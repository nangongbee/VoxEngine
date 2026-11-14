import { afterEach, expect, test } from "bun:test";
import { FakeTerminal, PCM16_16K } from "@voxengine/adapters/fake";
import { createEngine, type Engine, type Profile, type Tool } from "@voxengine/core";
import type { RealtimeEvent, RealtimeModel, RealtimeOptions, ToolResult } from "@voxengine/providers";
import type { AudioFrame, EngineEvent } from "@voxengine/protocol";
import { realtimeRuntime } from "@voxengine/runtimes/realtime";

let engine: Engine;
afterEach(() => engine?.close());

const frame = (): AudioFrame => ({ format: PCM16_16K, seq: 0, data: new Uint8Array(640) });

/** 假的端到端模型：测试代替厂商发事件，并记下 Runtime 对连接做了什么。 */
function fakeModel() {
  const state = {
    emit: (_: RealtimeEvent) => {},
    options: undefined as RealtimeOptions | undefined,
    heard: 0,
    hearing: false,
    canceled: 0,
    results: [] as ToolResult[][],
  };
  const model: RealtimeModel = {
    name: "fake-realtime",
    format: PCM16_16K,
    liveTranscripts: true,
    connect(options, emit) {
      state.options = options;
      state.emit = emit;
      return {
        pushAudio: () => void state.heard++,
        commit: () => state.hearing,
        cancel: () => void state.canceled++,
        submitToolResults: (results) => void state.results.push(results),
        close() {},
      };
    },
  };
  return { model, state };
}

function setup(model: RealtimeModel, profile: Partial<Profile> = {}) {
  engine = createEngine({ profile: { runtime: realtimeRuntime({ model }), instructions: "测试", ...profile } });
  const events: EngineEvent[] = [];
  engine.on((e) => events.push(e));
  const terminal = new FakeTerminal(engine, { capabilities: { vad: false } });
  terminal.send({ type: "session.start", trigger: "wake" });
  return { terminal, events };
}

/** 厂商回一整段：用户转写 → 回复文字和音频 → 说完。 */
function reply(emit: (e: RealtimeEvent) => void, frames: number, done = true) {
  emit({ type: "speech.started" });
  emit({ type: "transcript", text: "你好", final: true });
  emit({ type: "reply.started" });
  emit({ type: "reply.text", text: "你好呀。今天" });
  emit({ type: "reply.text", text: "天气不错！" });
  for (let i = 0; i < frames; i++) emit({ type: "audio", frame: frame() });
  if (done) emit({ type: "reply.done" });
}

test("一轮：厂商的转写、回复对到核心的轮次上，字幕按句", async () => {
  const { model, state } = fakeModel();
  const { terminal, events } = setup(model);
  await terminal.waitFor("session.started");
  expect(state.options).toMatchObject({ instructions: "测试", input: PCM16_16K });

  reply(state.emit, 3);
  expect(await terminal.waitFor("caption")).toMatchObject({ role: "user", text: "你好" });
  expect(await terminal.waitFor("caption")).toMatchObject({ role: "assistant", text: "你好呀。" });
  expect(await terminal.waitFor("caption")).toMatchObject({ role: "assistant", text: "今天天气不错！" });
  expect((await terminal.waitFor("play.stop")).reason).toBe("done");
  expect(terminal.count("audio.out")).toBe(3);
  expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  expect(events.find((e) => e.type === "session.started")).toMatchObject({ runtime: "realtime" });
});

test("服务端听到插话：停播、取消回复，旧回复的残余音频不播", async () => {
  const { model, state } = fakeModel();
  const { terminal, events } = setup(model);
  await terminal.waitFor("session.started");
  reply(state.emit, 50, false);
  await terminal.waitFor("play.start");

  state.emit({ type: "speech.started" });
  expect((await terminal.waitFor("play.stop")).reason).toBe("interrupted");
  expect(state.canceled).toBe(1);
  expect(events.find((e) => e.type === "interrupt")).toMatchObject({ source: "speech" });

  const sent = terminal.count("audio.out");
  state.emit({ type: "audio", frame: frame() });
  state.emit({ type: "reply.done" });
  expect(terminal.count("audio.out")).toBe(sent);

  reply(state.emit, 2);
  await terminal.waitFor("play.start");
  expect((await terminal.waitFor("play.stop")).reason).toBe("done");
});

test("工具由 Runtime 执行，同一批结果一起交回厂商", async () => {
  const tool: Tool = {
    name: "get_time",
    description: "现在几点",
    parameters: { type: "object" },
    invoke: async () => "18:04",
  };
  const { model, state } = fakeModel();
  const { terminal } = setup(model, { tools: [tool] });
  await terminal.waitFor("session.started");
  expect(state.options?.tools.map((t) => t.name)).toEqual(["get_time"]);

  state.emit({ type: "transcript", text: "几点了", final: true });
  state.emit({
    type: "tool_calls",
    calls: [
      { id: "c1", name: "get_time", arguments: "{}" },
      { id: "c2", name: "nope", arguments: "{}" },
    ],
  });
  await Bun.sleep(10);
  expect(state.results).toEqual([
    [
      { callId: "c1", content: "18:04" },
      { callId: "c2", content: "没有这个工具：nope" },
    ],
  ]);
});

test("设备说完但服务端没听到：这一轮直接结束，回到听", async () => {
  const { model, state } = fakeModel();
  const { terminal, events } = setup(model, { idleTimeoutMs: 50 });
  await terminal.waitFor("session.started");
  terminal.say(3);
  expect(state.heard).toBe(3);
  expect((await terminal.waitFor("session.ended")).reason).toBe("idle");
  expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
});

test("厂商不支持文字输入：这一轮报可恢复错误，会话继续", async () => {
  const { model } = fakeModel();
  const { terminal, events } = setup(model);
  await terminal.waitFor("session.started");
  terminal.send({ type: "user.text", text: "你好" });
  await Bun.sleep(10);
  expect(events.find((e) => e.type === "error")?.type).toBe("error");
  expect(events.some((e) => e.type === "session.ended")).toBe(false);
});

test("关掉插话：播放期间的上行音频不送给厂商", async () => {
  const { model, state } = fakeModel();
  const { terminal } = setup(model, { bargeIn: false });
  await terminal.waitFor("session.started");
  reply(state.emit, 50, false);
  await terminal.waitFor("play.start");

  const before = state.heard;
  terminal.send({ type: "audio.in", frame: frame() });
  expect(state.heard).toBe(before);
  state.emit({ type: "speech.started" });
  expect(terminal.count("play.stop")).toBe(0);
});
