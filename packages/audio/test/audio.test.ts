import { expect, test } from "bun:test";
import OpusScript from "opusscript";
import { dbfs, OggOpusReader, OpusDecoder, opusPacketMs } from "../src/index.ts";

/** 拼一页 Ogg：只填读包需要的字段。 */
function oggPage(sequence: number, packets: Uint8Array[]): Uint8Array {
  const table: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      table.push(255);
      n -= 255;
    }
    table.push(n);
  }
  const body = packets.reduce((n, p) => n + p.length, 0);
  const page = new Uint8Array(27 + table.length + body);
  page.set([0x4f, 0x67, 0x67, 0x53]);
  new DataView(page.buffer).setUint32(18, sequence, true);
  page[26] = table.length;
  page.set(table, 27);
  let offset = 27 + table.length;
  for (const p of packets) {
    page.set(p, offset);
    offset += p.length;
  }
  return page;
}

test("Ogg：跳过头包，分块喂也能拆出完整包", () => {
  const head = new TextEncoder().encode("OpusHead\x01\x01");
  const tags = new TextEncoder().encode("OpusTags....");
  const big = new Uint8Array(300).fill(7);
  const stream = new Uint8Array([...oggPage(0, [head]), ...oggPage(1, [tags]), ...oggPage(2, [new Uint8Array([1, 2]), big])]);

  const reader = new OggOpusReader();
  const packets = [...reader.push(stream.subarray(0, 50)), ...reader.push(stream.subarray(50))];
  expect(packets.map((p) => p.length)).toEqual([2, 300]);
});

test("Opus TOC：算出包时长", () => {
  expect(opusPacketMs(new Uint8Array([(11 << 3) | 0]))).toBe(60);
  expect(opusPacketMs(new Uint8Array([(31 << 3) | 0]))).toBe(20);
  expect(opusPacketMs(new Uint8Array([(31 << 3) | 1]))).toBe(40);
  expect(opusPacketMs(new Uint8Array([(16 << 3) | 3, 4]))).toBe(10);
});

test("Opus 解码：60 ms 包解出 960 个样本，响度合理", () => {
  const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  const tone = new Int16Array(960).map((_, i) => Math.round(8000 * Math.sin(i / 5)));
  const packet = new Uint8Array(encoder.encode(Buffer.from(tone.buffer), 960));
  encoder.delete();

  const decoder = new OpusDecoder(16000);
  const pcm = decoder.decode(packet);
  decoder.destroy();
  expect(opusPacketMs(packet)).toBe(60);
  expect(pcm.length).toBe(960);
  expect(dbfs(pcm)).toBeGreaterThan(-20);
  expect(dbfs(new Int16Array(960))).toBe(-90);
});
