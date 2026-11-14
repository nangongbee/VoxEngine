import { expect, test } from "bun:test";
import type { AudioFrame } from "@voxengine/protocol";
import { Player } from "../src/player.ts";

const frame = (seq: number): AudioFrame => ({
  format: { codec: "pcm16", sampleRate: 16000, channels: 1, frameMs: 20 },
  seq,
  data: new Uint8Array(0),
});

test("入队不立刻发，按墙钟每 20ms 一包", async () => {
  const sent: number[] = [];
  let drained = false;
  const player = new Player({ leadMs: 60, send: (f) => sent.push(f.seq), onDrained: () => (drained = true) });

  for (let i = 0; i < 10; i++) player.push(frame(i));
  player.finish();
  expect(sent.length).toBe(0);

  await Bun.sleep(50);
  expect(sent.length).toBeGreaterThanOrEqual(1);
  expect(sent.length).toBeLessThanOrEqual(4);

  await Bun.sleep(250);
  expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(drained).toBe(true);
});

test("有超前量配置也不会按倍速灌包", async () => {
  const sent: number[] = [];
  const player = new Player({ leadMs: 400, send: (f) => sent.push(f.seq), onDrained: () => {} });
  for (let i = 0; i < 100; i++) player.push(frame(i));
  await Bun.sleep(45);
  // 45ms 墙钟最多大约两包，不是 lead/帧长 那么多
  expect(sent.length).toBeLessThanOrEqual(4);
  player.stop();
});

test("stop 返回已下发时长", async () => {
  const player = new Player({ leadMs: 60, send: () => {}, onDrained: () => {} });
  for (let i = 0; i < 50; i++) player.push(frame(i));
  await Bun.sleep(120);
  const played = player.stop();
  expect(played).toBeGreaterThanOrEqual(60);
  expect(played).toBeLessThanOrEqual(200);
});
