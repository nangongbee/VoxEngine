import { afterEach, expect, test } from "bun:test";
import { FakeTerminal, PCM16_16K } from "@voxengine/adapters/fake";
import { createEngine, type Engine, type Profile, type Runtime, type RuntimeContext, type Tool } from "@voxengine/core";
import type { AudioFormat, AudioFrame, EngineEvent } from "@voxengine/protocol";

let engine: Engine;
afterEach(() => engine?.close());

const caps = { liveTranscripts: true, tools: true, bargeIn: true };

async function* frames(count: number, format: AudioFormat = PCM16_16K): AsyncGenerator<AudioFrame> {
  for (let seq = 0; seq < count; seq++) yield { format, seq, data: new Uint8Array(640) };
}

/** 收到文字就调第一个工具；reply 为真时再说几帧确认语。 */
function caller(options: { reply?: boolean; onResult?: (result: Promise<string>) => void } = {}) {
  const seen = { interrupts: 0, closed: false, opens: 0, ctx: undefined as RuntimeContext | undefined };
  const runtime: Runtime = {
    name: "caller",
    open(ctx) {
      seen.ctx = ctx;
      seen.opens++;
      seen.closed = false;
      return {
        capabilities: caps,
        pushAudio() {},
        endOfSpeech() {},
        async pushText() {
          const result = ctx.tools[0]!.invoke({});
          options.onResult?.(result);
          await result.catch(() => {});
          if (!options.reply) return;
          for await (const frame of frames(3)) ctx.emit({ type: "audio", frame });
          ctx.emit({ type: "reply.done" });
        },
        interrupt() {
          seen.interrupts++;
        },
        close() {
          seen.closed = true;
        },
      };
    },
  };
  return { runtime, seen };
}

function tool(invoke: Tool["invoke"], extra: Partial<Tool> = {}): Tool {
  return { name: "play", description: "播一段", parameters: { type: "object" }, invoke, ...extra };
}

function setup(profile: Partial<Profile> & Pick<Profile, "runtime">) {
  engine = createEngine({ profile });
  const events: EngineEvent[] = [];
  engine.on((event) => events.push(event));
  const terminal = new FakeTerminal(engine);
  const find = <T extends EngineEvent["type"]>(type: T) =>
    events.find((e) => e.type === type) as Extract<EngineEvent, { type: T }> | undefined;
  return { events, terminal, find };
}

test("工具带音频：确认语播完再播，播完回到听", async () => {
  const { runtime } = caller({ reply: true });
  const media = { title: "小兔子", frames: frames(5) };
  const { terminal, find } = setup({ runtime, tools: [tool(async () => ({ content: "好", media }))] });
  terminal.send({ type: "user.text", text: "讲故事" });

  const reply = await terminal.waitFor("play.start");
  expect(reply.kind).toBe("reply");
  expect((await terminal.waitFor("play.stop")).reason).toBe("done");
  const story = await terminal.waitFor("play.start");
  expect(story).toMatchObject({ kind: "media", turnId: reply.turnId });
  expect((await terminal.waitFor("play.stop")).reason).toBe("done");

  expect(terminal.count("audio.out")).toBe(8);
  expect(find("media.started")).toMatchObject({ title: "小兔子" });
  expect(find("media.ended")).toMatchObject({ reason: "done", playedMs: 100 });
  expect(terminal.count("session.ended")).toBe(0);
});

test("模型一直不开口：等 waitMs 后直接播", async () => {
  const { runtime } = caller();
  const media = { frames: frames(2) };
  const { terminal } = setup({ runtime, tools: [tool(async () => ({ content: "好", media }))], media: { waitMs: 30 } });
  terminal.send({ type: "user.text", text: "讲故事" });
  expect((await terminal.waitFor("play.start")).kind).toBe("media");
});

test("按键打断媒体：停播，不去打断已经说完的回复", async () => {
  const { runtime, seen } = caller({ reply: true });
  const media = { frames: frames(100) };
  const { terminal, find } = setup({ runtime, tools: [tool(async () => ({ content: "好", media }))] });
  terminal.send({ type: "user.text", text: "讲故事" });
  await terminal.waitFor("play.stop");
  await terminal.waitFor("play.start");
  await Bun.sleep(60);

  terminal.send({ type: "user.interrupt" });
  expect((await terminal.waitFor("play.stop")).reason).toBe("interrupted");
  expect(find("media.ended")?.reason).toBe("interrupted");
  expect(seen.interrupts).toBe(0);
  expect(terminal.count("audio.out")).toBeLessThan(103);
});

test("媒体不许说话打断：用户开口照播，按键仍能停", async () => {
  const { runtime } = caller();
  const media = { frames: frames(100), bargeIn: false };
  const { terminal } = setup({ runtime, tools: [tool(async () => ({ content: "好", media }))], media: { waitMs: 0 } });
  terminal.send({ type: "user.text", text: "讲故事" });
  await terminal.waitFor("play.start");
  terminal.send({ type: "speech.start" });
  await Bun.sleep(40);
  expect(terminal.count("play.stop")).toBe(0);
  terminal.send({ type: "user.interrupt" });
  expect((await terminal.waitFor("play.stop")).reason).toBe("interrupted");
});

test("after: end：播完结束会话，原因 done", async () => {
  const { runtime } = caller();
  const media = { frames: frames(2), after: "end" as const };
  const { terminal } = setup({ runtime, tools: [tool(async () => ({ content: "好", media }))], media: { waitMs: 0 } });
  terminal.send({ type: "user.text", text: "讲故事" });
  expect((await terminal.waitFor("session.ended")).reason).toBe("done");
});

test("媒体格式和设备下行不一致：报错，回到听", async () => {
  const { runtime } = caller();
  const opus = { codec: "opus", sampleRate: 24000, channels: 1, frameMs: 20 } as const;
  const media = { frames: frames(2, opus) };
  const { terminal, find } = setup({ runtime, tools: [tool(async () => ({ content: "好", media }))], media: { waitMs: 0 } });
  terminal.send({ type: "user.text", text: "讲故事" });
  await terminal.waitFor("play.stop");
  expect(find("media.ended")?.reason).toBe("error");
  expect(find("error")?.error.message).toContain("opus/24000");
  expect(terminal.count("audio.out")).toBe(0);
});

test("工具超时：Runtime 拿到超时错误，工具收到取消信号", async () => {
  let signal: AbortSignal | undefined;
  let result: Promise<string> | undefined;
  const { runtime } = caller({ onResult: (r) => (result = r) });
  const slow = tool(
    (_, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    },
    { timeoutMs: 30 },
  );
  const { terminal, find } = setup({ runtime, tools: [slow] });
  terminal.send({ type: "user.text", text: "查一下" });
  await terminal.waitFor("session.started");

  await expect(result!).rejects.toThrow("工具超时");
  expect(signal?.reason).toBe("timeout");
  expect(find("tool.returned")).toMatchObject({ ok: false, failure: "timeout" });
});

test("会话结束：取消还在跑的工具", async () => {
  let signal: AbortSignal | undefined;
  const { runtime } = caller({ onResult: (r) => void r.catch(() => {}) });
  const slow = tool((_, ctx) => {
    signal = ctx.signal;
    return new Promise(() => {});
  });
  const { terminal, find } = setup({ runtime, tools: [slow] });
  terminal.send({ type: "user.text", text: "查一下" });
  await terminal.waitFor("session.started");
  await Bun.sleep(10);

  terminal.send({ type: "session.end" });
  await terminal.waitFor("session.ended");
  expect(signal?.reason).toBe("ended");
  expect(find("tool.returned")).toMatchObject({ ok: false, failure: "cancelled" });
});

test("长媒体播放中没人说话：释放 Runtime，媒体照播，播完结束会话", async () => {
  const { runtime, seen } = caller();
  const media = { frames: frames(20) };
  const { terminal, find } = setup({
    runtime,
    tools: [tool(async () => ({ content: "好", media }))],
    media: { waitMs: 0, releaseRuntimeMs: 50 },
  });
  terminal.send({ type: "user.text", text: "讲故事" });
  await terminal.waitFor("play.start");
  await Bun.sleep(100);
  expect(seen.closed).toBe(true);
  expect(find("runtime.released")).toBeDefined();

  expect((await terminal.waitFor("play.stop")).reason).toBe("done");
  expect((await terminal.waitFor("session.ended")).reason).toBe("done");
  expect(terminal.count("audio.out")).toBe(20);
});

test("释放后被唤醒或按键打断：停掉媒体，重开 Runtime 回到听，会话不结束", async () => {
  const { runtime, seen } = caller();
  const { terminal, find } = setup({
    runtime,
    tools: [tool(async () => ({ content: "好", media: { frames: frames(200) } }))],
    media: { waitMs: 0, releaseRuntimeMs: 50 },
  });
  terminal.send({ type: "user.text", text: "讲故事" });
  await terminal.waitFor("play.start");
  await Bun.sleep(100);
  expect(seen.closed).toBe(true);

  terminal.send({ type: "user.interrupt", reason: "wake_word_detected" });
  expect((await terminal.waitFor("play.stop")).reason).toBe("interrupted");
  expect(find("runtime.reopened")).toBeDefined();
  expect(seen.opens).toBe(2);
  expect(seen.closed).toBe(false);
  expect(find("session.ended")).toBeUndefined();
});

test("Profile.deviceTools 筛选、改写设备工具", async () => {
  const { runtime, seen } = caller();
  const { terminal } = setup({
    runtime,
    deviceTools: (tools) => tools.filter((t) => t.name === "set_volume").map((t) => ({ ...t, description: "调音量" })),
  });
  terminal.send({
    type: "tool.list",
    tools: [
      { name: "set_volume", description: "原描述", parameters: { type: "object" } },
      { name: "reboot", description: "重启", parameters: { type: "object" } },
    ],
  });
  terminal.send({ type: "session.start", trigger: "wake" });
  await terminal.waitFor("session.started");
  expect(seen.ctx!.tools.map((t) => [t.name, t.description])).toEqual([["set_volume", "调音量"]]);
});

test("无限长的媒体流按播放进度取帧，打断后流被关掉", async () => {
  const { runtime } = caller();
  let pulled = 0;
  let closed = false;
  async function* endless(): AsyncGenerator<AudioFrame> {
    try {
      for (let seq = 0; ; seq++) {
        pulled++;
        yield { format: PCM16_16K, seq, data: new Uint8Array(640) };
      }
    } finally {
      closed = true;
    }
  }
  const { terminal } = setup({ runtime, tools: [tool(async () => ({ content: "好", media: { frames: endless() } }))], media: { waitMs: 0 } });
  terminal.send({ type: "user.text", text: "循环播" });
  await terminal.waitFor("play.start");
  await Bun.sleep(200);
  // 预读数秒，再加 200 ms 实际播放，一帧 20 ms：远少于空转时的成千上万帧。
  expect(pulled).toBeLessThan(400);

  terminal.send({ type: "user.interrupt" });
  await terminal.waitFor("play.stop");
  await Bun.sleep(10);
  expect(closed).toBe(true);
});
