import { expect, test } from "bun:test";
import { decode, encodeAudio } from "../src/xiaozhi/codec.ts";

const opus = new Uint8Array([1, 2, 3, 4, 5]);

test.each([1, 2, 3])("v%i 音频帧编解码往返", (version) => {
  const decoded = decode(encodeAudio(opus, version), version);
  expect(decoded).toEqual({ type: "audio", data: opus });
});

test("hello：读出音频参数和 MCP", () => {
  const msg = decode(
    JSON.stringify({
      type: "hello",
      version: 1,
      features: { mcp: true },
      transport: "websocket",
      audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
    }),
    1,
  );
  expect(msg).toEqual({
    type: "hello",
    purpose: undefined,
    mcp: true,
    audioIn: { codec: "opus", sampleRate: 16000, channels: 1, frameMs: 60 },
  });
});

test("listen detect 带唤醒词", () => {
  expect(decode('{"type":"listen","state":"detect","text":"你好小智"}', 1)).toMatchObject({
    type: "listen",
    state: "detect",
    text: "你好小智",
  });
});

test("不认识的 JSON 不抛错", () => {
  expect(decode("not json", 1).type).toBe("unknown");
  expect(decode('{"type":"custom"}', 1).type).toBe("unknown");
});
