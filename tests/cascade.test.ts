import { afterEach, expect, test } from "bun:test";
import { FakeTerminal, PCM16_16K } from "@voxengine/adapters/fake";
import { createEngine, type Engine, type Profile, type Tool } from "@voxengine/core";
import type { ChatChunk, ChatMessage, LanguageModel, SpeechToText, TextToSpeech, VoiceActivityDetector } from "@voxengine/providers";
import type { EngineEvent } from "@voxengine/protocol";
import { cascadeRuntime } from "@voxengine/runtimes/cascade";

let engine: Engine;
afterEach(() => engine?.close());

/** 样本非零就算人声。 */
const fakeVad = (): VoiceActivityDetector => ({ name: "fake", isSpeech: (pcm) => pcm[0] !== 0 });
const fakeStt: SpeechToText = { name: "fake-stt", transcribe: async () => ({ text: "你好", usage: [] }) };

/** 每个字合成 1 帧 20 ms 静音。 */
const fakeTts: TextToSpeech = {
  name: "fake-tts",
  format: PCM16_16K,
  async *synthesize(text) {
    for (let i = 0; i < text.length; i++) {
      yield { type: "audio", frame: { format: PCM16_16K, seq: i, data: new Uint8Array(640) } };
    }
  },
};

/** 按顺序回放预设的几轮输出，并记下每次收到的消息。 */
function scriptedLlm(rounds: ChatChunk[][]): LanguageModel & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: "scripted",
    calls,
    async *generate(messages) {
      calls.push(structuredClone(messages));
      for (const chunk of rounds[calls.length - 1] ?? [{ type: "text", text: "嗯。" }]) yield chunk;
    },
  };
}

/** 按顺序给出识别结果，用完了就一直给最后一个。 */
function scriptedStt(texts: string[]): SpeechToText {
  let i = 0;
  return { name: "scripted-stt", transcribe: async () => ({ text: texts[Math.min(i++, texts.length - 1)]!, usage: [] }) };
}

function setup(
  llm: LanguageModel,
  tools: Tool[] = [],
  extra: { stt?: SpeechToText; startOn?: "voice" | "transcript"; profile?: Partial<Profile> } = {},
) {
  const runtime = cascadeRuntime({
    stt: extra.stt ?? fakeStt,
    llm,
    tts: fakeTts,
    vad: fakeVad,
    endpoint: { silenceMs: 100, minSpeechMs: 40 },
    startOn: extra.startOn,
  });
  engine = createEngine({ profile: { runtime, instructions: "你是测试助手", tools, ...extra.profile } });
  const events: EngineEvent[] = [];
  engine.on((e) => events.push(e));
  const terminal = new FakeTerminal(engine, { capabilities: { vad: false } });
  terminal.send({ type: "session.start", trigger: "wake" });
  return { terminal, events };
}

/** 说 speechFrames 帧有声的，再跟 silenceFrames 帧静音。 */
function speak(terminal: FakeTerminal, speechFrames: number, silenceFrames = 6) {
  const frame = (value: number) => {
    const pcm = new Int16Array(320).fill(value);
    return { format: PCM16_16K, seq: 0, data: new Uint8Array(pcm.buffer) };
  };
  for (let i = 0; i < speechFrames; i++) terminal.send({ type: "audio.in", frame: frame(1000) });
  for (let i = 0; i < silenceFrames; i++) terminal.send({ type: "audio.in", frame: frame(0) });
}

test("一轮：VAD 切句 → 识别 → 模型按句 → 合成 → 播完", async () => {
  const llm = scriptedLlm([[{ type: "text", text: "你好呀。今天" }, { type: "text", text: "天气不错！" }]]);
  const { terminal, events } = setup(llm);
  speak(terminal, 5);

  expect(await terminal.waitFor("caption")).toMatchObject({ role: "user", text: "你好" });
  expect(await terminal.waitFor("caption")).toMatchObject({ role: "assistant", text: "你好呀。" });
  expect(await terminal.waitFor("caption")).toMatchObject({ role: "assistant", text: "今天天气不错！" });
  expect((await terminal.waitFor("play.stop")).reason).toBe("done");
  expect(terminal.count("audio.out")).toBe("你好呀。今天天气不错！".length);
  expect(llm.calls[0]).toEqual([
    { role: "system", content: "你是测试助手" },
    { role: "user", content: "你好" },
  ]);
  expect(events.some((e) => e.type === "latency")).toBe(true);
});

test("工具：模型调工具 → 结果写回 → 追问一轮再说", async () => {
  let volume = 0;
  const setVolume: Tool = {
    name: "set_volume",
    description: "调音量",
    parameters: { type: "object" },
    invoke: async (args) => {
      volume = (args as { level: number }).level;
      return "ok";
    },
  };
  const llm = scriptedLlm([
    [{ type: "tool_call", call: { id: "c1", name: "set_volume", arguments: '{"level":3}' } }],
    [{ type: "text", text: "调好了。" }],
  ]);
  const { terminal } = setup(llm, [setVolume]);
  speak(terminal, 5);

  expect(await terminal.waitFor("caption")).toMatchObject({ role: "user" });
  expect(await terminal.waitFor("caption")).toMatchObject({ role: "assistant", text: "调好了。" });
  expect(volume).toBe(3);
  expect(llm.calls[1]!.slice(-2)).toEqual([
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "set_volume", arguments: '{"level":3}' }] },
    { role: "tool", toolCallId: "c1", content: "ok" },
  ]);
});

test("打断：历史里只留用户听到的部分", async () => {
  const long = "这是一段很长很长的回答，".repeat(5) + "说完了。";
  const llm = scriptedLlm([[{ type: "text", text: long }], [{ type: "text", text: "好。" }]]);
  const { terminal, events } = setup(llm);
  speak(terminal, 5);
  await terminal.waitFor("play.start");
  await Bun.sleep(150);

  speak(terminal, 5);
  expect((await terminal.waitFor("play.stop")).reason).toBe("interrupted");
  await terminal.waitFor("play.start");

  const assistant = llm.calls[1]!.find((m) => m.role === "assistant")!;
  expect(assistant.content).toContain("被用户打断");
  expect(assistant.content.length).toBeLessThan(long.length);
  expect(events.find((e) => e.type === "interrupt")).toMatchObject({ source: "speech" });
});

test("识别为空：不算开口，不开新一轮", async () => {
  const llm = scriptedLlm([]);
  const { terminal, events } = setup(llm, [], { stt: scriptedStt([""]) });
  speak(terminal, 5);
  await Bun.sleep(150);
  expect(events.some((e) => e.type === "turn.started")).toBe(false);
  expect(llm.calls).toHaveLength(0);
});

test("播放中识别出的碎片没过 acceptUtterance：不打断，记一条忽略", async () => {
  const long = "这是一段很长很长的回答，".repeat(5) + "说完了。";
  const llm = scriptedLlm([[{ type: "text", text: long }]]);
  const { terminal, events } = setup(llm, [], {
    stt: scriptedStt(["你好", "行"]),
    profile: { acceptUtterance: (text, { playing }) => !playing || text.length >= 4 },
  });
  speak(terminal, 5);
  await terminal.waitFor("play.start");
  speak(terminal, 5);

  expect((await terminal.waitFor("play.stop")).reason).toBe("done");
  expect(events.find((e) => e.type === "utterance.ignored")).toMatchObject({ text: "行", playing: true });
  expect(llm.calls).toHaveLength(1);
});

test("startOn voice：听到人声就打断，不等识别", async () => {
  const long = "这是一段很长很长的回答，".repeat(5) + "说完了。";
  const llm = scriptedLlm([[{ type: "text", text: long }]]);
  const { terminal } = setup(llm, [], { stt: scriptedStt(["你好", ""]), startOn: "voice" });
  speak(terminal, 5);
  await terminal.waitFor("play.start");
  speak(terminal, 5, 0);
  expect((await terminal.waitFor("play.stop")).reason).toBe("interrupted");
});

test("模型出错：这一轮报错，会话继续", async () => {
  const failing: LanguageModel = {
    name: "failing",
    async *generate() {
      throw new Error("模型挂了");
    },
  };
  const { terminal, events } = setup(failing);
  speak(terminal, 5);
  await terminal.waitFor("caption");
  await Bun.sleep(20);

  expect(events.find((e) => e.type === "error")).toBeDefined();
  expect(events.some((e) => e.type === "session.ended")).toBe(false);
});
