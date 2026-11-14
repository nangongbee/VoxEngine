import { expect, test } from "bun:test";
import type { AudioFormat, AudioFrame } from "@voxengine/protocol";
import { doubaoRealtime, type SocketHandlers } from "../src/doubao/realtime.ts";
import type { RealtimeEvent } from "../src/types.ts";

const OPUS_16K: AudioFormat = { codec: "opus", sampleRate: 16000, channels: 1, frameMs: 60 };
const frame = (): AudioFrame => ({ format: OPUS_16K, seq: 0, data: new Uint8Array([1, 2, 3]) });

/** 一页 Ogg，装一个 20 ms 的 Opus 包。 */
function oggPage(sequence: number): string {
  const packet = new Uint8Array([31 << 3, 9, 9]);
  const page = new Uint8Array(28 + packet.length);
  page.set([0x4f, 0x67, 0x67, 0x53]);
  new DataView(page.buffer).setUint32(18, sequence, true);
  page[26] = 1;
  page[27] = packet.length;
  page.set(packet, 28);
  return Buffer.from(page).toString("base64");
}

function connect(tools = [{ name: "get_time", description: "几点", parameters: { type: "object" } }]) {
  const sent: Record<string, any>[] = [];
  const events: RealtimeEvent[] = [];
  let on!: SocketHandlers;
  let closed = false;
  const model = doubaoRealtime({
    apiKey: "k",
    voice: "v",
    muteIdleMs: 30,
    socket: (_url, headers, handlers) => {
      expect(headers).toEqual({ "X-Api-Key": "k" });
      on = handlers;
      return { send: (text) => void sent.push(JSON.parse(text)), close: () => void (closed = true) };
    },
  });
  const connection = model.connect({ instructions: "你是助手", tools, input: OPUS_16K }, (e) => events.push(e));
  const server = (event: Record<string, unknown>) => on.message(JSON.stringify(event));
  const types = () => sent.map((e) => e.type);
  return { connection, sent, events, server, types, on: () => on, closed: () => closed };
}

test("建会话：带上提示词、工具、上行格式；建好前的音频攒着，建好后补发", () => {
  const { connection, sent, server, types, on } = connect();
  connection.pushAudio(frame());
  on().open();
  expect(sent[0]).toMatchObject({
    type: "session.create",
    session: {
      instructions: "你是助手",
      tools: [{ type: "function", name: "get_time" }],
      audio: { input: { format: { type: "speech_opus", rate: 16000 } }, output: { format: { type: "ogg_opus" }, voice: "v" } },
    },
  });
  expect(types()).toEqual(["session.create"]);

  server({ type: "session.created", session: { id: "s1" } });
  expect(types()).toEqual(["session.create", "input_audio_buffer.append"]);
  expect(sent[1]!.audio).toBe(Buffer.from([1, 2, 3]).toString("base64"));
});

test("一段回复：文字先到也只开一次；Ogg 拆成帧；audio.done 结束", () => {
  const { events, server, on } = connect();
  on().open();
  server({ type: "conversation.item.input_audio_transcription.completed", item_id: "q1", text: "你好" });
  server({ type: "response.output_text.delta", question_id: "q1", response_id: "r1", delta: "你好" });
  server({ type: "response.output_audio.started", question_id: "q1", response_id: "r1" });
  server({ type: "response.output_audio.delta", delta: oggPage(0) });
  server({ type: "response.output_audio.delta", delta: oggPage(1) });
  server({ type: "response.output_audio.done", question_id: "q1", response_id: "r1" });

  expect(events.map((e) => e.type)).toEqual(["transcript", "reply.started", "reply.text", "audio", "audio", "reply.done"]);
  const audio = events.find((e) => e.type === "audio");
  expect(audio?.type === "audio" && audio.frame.format).toMatchObject({ codec: "opus", sampleRate: 24000, frameMs: 20 });
});

test("服务端自己判出插话：补 reply.done；这段回复迟到的文字和音频都不再出来", () => {
  const { events, server, on, connection } = connect();
  on().open();
  server({ type: "response.output_audio.started", response_id: "r1" });
  server({ type: "conversation.item.input_audio_transcription.started", item_id: "q2" });
  expect(events.map((e) => e.type)).toEqual(["reply.started", "reply.done", "speech.started"]);

  server({ type: "response.output_text.delta", response_id: "r1", delta: "迟到" });
  server({ type: "response.output_audio.delta", delta: oggPage(0) });
  expect(events).toHaveLength(3);
  expect(connection.commit()).toBe(true);
});

test("客户端取消：发 response.cancel，残余不再出来；没在回复时不发", () => {
  const { events, server, on, connection, types } = connect();
  on().open();
  server({ type: "session.created" });
  connection.cancel();
  expect(types()).not.toContain("response.cancel");

  server({ type: "response.output_text.delta", response_id: "r1", delta: "一" });
  connection.cancel();
  expect(types()).toContain("response.cancel");
  server({ type: "response.output_text.delta", response_id: "r1", delta: "二" });
  server({ type: "response.output_audio.delta", delta: oggPage(0) });
  expect(events.map((e) => e.type)).toEqual(["reply.started", "reply.text"]);
});

test("工具调用和结果、用量", () => {
  const { events, server, on, connection, sent } = connect();
  on().open();
  server({ type: "session.created" });
  server({ type: "response.function_call_arguments.done", items: [{ call_id: "c1", name: "get_time", arguments: "{}" }] });
  expect(events[0]).toEqual({ type: "tool_calls", calls: [{ id: "c1", name: "get_time", arguments: "{}" }] });

  connection.submitToolResults([{ callId: "c1", content: "18:04" }]);
  expect(sent.at(-1)).toEqual({
    type: "conversation.item.create",
    items: [{ call_id: "c1", role: "tool", content: [{ type: "input_text", text: "18:04" }] }],
  });

  server({
    type: "response.done",
    response: {
      usage: {
        input_token_details: { text_tokens: 100, audio_tokens: 0, cached_tokens_details: { text_tokens: 60 } },
        output_token_details: { text_tokens: 10, audio_tokens: 40 },
      },
    },
  });
  const usage = events.at(-1);
  expect(usage?.type === "usage" && usage.usage.map((u) => [u.unit, u.units])).toEqual([
    ["tokens_in_text", 100],
    ["tokens_in_text_cached", 60],
    ["tokens_out_text", 10],
    ["tokens_out_audio", 40],
  ]);
});

test("一段时间没上行就关麦，再来音频先开麦", async () => {
  const { connection, server, on, types } = connect();
  on().open();
  server({ type: "session.created" });
  connection.pushAudio(frame());
  await Bun.sleep(50);
  connection.pushAudio(frame());
  expect(types().slice(1)).toEqual([
    "input_audio_buffer.append",
    "input_audio_mute.commit",
    "input_audio_unmute.commit",
    "input_audio_buffer.append",
  ]);
  connection.close();
});

test("意外断线是致命错误；主动关闭先发 session.close，不报错", () => {
  const a = connect();
  a.on().open();
  a.on().close(1006, "");
  expect(a.events[0]).toMatchObject({ type: "error" });
  expect(a.events[0]?.type === "error" && a.events[0].recoverable).toBeFalsy();

  const b = connect();
  b.on().open();
  b.server({ type: "session.created" });
  b.connection.close();
  expect(b.types().at(-1)).toBe("session.close");
  b.server({ type: "session.closed" });
  expect(b.closed()).toBe(true);
  b.on().close(1000, "");
  expect(b.events).toHaveLength(0);
});

test("收不了的上行格式：报致命错误，不建会话", async () => {
  const events: RealtimeEvent[] = [];
  let on!: SocketHandlers;
  const sent: string[] = [];
  const model = doubaoRealtime({
    apiKey: "k",
    socket: (_u, _h, handlers) => {
      on = handlers;
      return { send: (t) => void sent.push(t), close() {} };
    },
  });
  model.connect({ instructions: "", tools: [], input: { ...OPUS_16K, sampleRate: 48000 } }, (e) => events.push(e));
  on.open();
  await Bun.sleep(0);
  expect(sent).toHaveLength(0);
  expect(events[0]).toMatchObject({ type: "error" });
});
