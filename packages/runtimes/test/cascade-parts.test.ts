import { expect, test } from "bun:test";
import type { VoiceActivityDetector } from "@voxengine/providers";
import { heardText } from "../src/cascade/index.ts";
import { SentenceSplitter } from "../src/cascade/sentences.ts";
import { TurnTaker } from "../src/cascade/turn-taker.ts";

test("切句：句号类一定切，逗号类攒够字数才切，去掉 markdown 符号", () => {
  const splitter = new SentenceSplitter(6);
  expect(splitter.push("你好，")).toEqual([]);
  expect(splitter.push("**我是**助手。今天")).toEqual(["你好，我是助手。"]);
  expect(splitter.push("天气晴朗，适合出去玩")).toEqual(["今天天气晴朗，"]);
  expect(splitter.flush()).toEqual(["适合出去玩"]);
  expect(splitter.push("。！")).toEqual([]);
});

test("听到的部分：整句播完的全算，正在播的按比例，没出音频的不算", () => {
  const spoken = [
    { text: "第一句。", ms: 400 },
    { text: "第二句话。", ms: 500 },
    { text: "第三句。", ms: 0 },
  ];
  expect(heardText(spoken, 0)).toBe("");
  expect(heardText(spoken, 400)).toBe("第一句。");
  expect(heardText(spoken, 600)).toBe("第一句。第二");
  expect(heardText(spoken, 5000)).toBe("第一句。第二句话。");
});

function taker(options = {}) {
  const events: string[] = [];
  const vad: VoiceActivityDetector = { name: "fake", isSpeech: (pcm) => pcm[0] !== 0 };
  const t = new TurnTaker(
    vad,
    16000,
    { onSpeechStart: () => events.push("start"), onUtterance: (pcm) => events.push(`utterance:${pcm.length}`) },
    { silenceMs: 60, minSpeechMs: 40, preRollMs: 40, ...options },
  );
  const push = (speech: boolean, n: number) => {
    for (let i = 0; i < n; i++) t.push(new Int16Array(320).fill(speech ? 1 : 0), 20);
  };
  return { t, events, push };
}

test("端点：开口够长才报开口，静音够长交出整句（含开口前的预录）", () => {
  const { events, push } = taker();
  push(false, 5);
  push(true, 1);
  expect(events).toEqual([]);
  push(true, 2);
  expect(events).toEqual(["start"]);
  push(false, 3);
  expect(events).toEqual(["start", `utterance:${320 * (2 + 3 + 3)}`]);
});

test("端点：太短的声音（咳嗽）不算一句", () => {
  const { events, push } = taker();
  push(true, 1);
  push(false, 5);
  expect(events).toEqual([]);
});

test("端点：flush 交出正在说的一句", () => {
  const { t, events, push } = taker();
  push(true, 3);
  expect(t.flush()).toBe(true);
  expect(events).toEqual(["start", `utterance:${320 * 3}`]);
  expect(t.flush()).toBe(false);
});
