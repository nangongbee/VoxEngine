// 一个自定义工具：从目录里挑一个故事播放。只演示「工具返回音频」这个口子，不是曲库。
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { OggOpusReader, opusPacketMs } from "@voxengine/audio";
import type { Tool } from "@voxengine/core";
import type { AudioFormat, AudioFrame } from "@voxengine/protocol";

export function storyTool(dir: string): Tool {
  return {
    name: "play_story",
    description: "从故事库挑一个故事播放。用户要听故事时调用，不要自己编。可以按名字挑，不给名字就随机。",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "故事名里的关键字，可空" } },
    },
    async invoke(args, ctx) {
      if (ctx.output.codec !== "opus") throw new Error(`设备下行是 ${ctx.output.codec}，这个例子只播 Ogg Opus`);
      const files = readdirSync(dir).filter((name) => name.endsWith(".ogg"));
      if (files.length === 0) return "故事库是空的。";
      const title = typeof (args as { title?: unknown }).title === "string" ? (args as { title: string }).title : "";
      const file = files.find((name) => title && name.includes(title)) ?? files[Math.floor(Math.random() * files.length)]!;
      const name = basename(file, ".ogg");
      return {
        content: `网关会直接播放《${name}》。你只用一句很短的话确认，不要复述内容。`,
        media: { title: name, frames: readOgg(join(dir, file), ctx.output) },
      };
    },
  };
}

async function* readOgg(path: string, output: AudioFormat): AsyncGenerator<AudioFrame> {
  const reader = new OggOpusReader();
  let seq = 0;
  for (const packet of reader.push(new Uint8Array(await Bun.file(path).arrayBuffer()))) {
    yield { format: { ...output, frameMs: opusPacketMs(packet) }, seq: seq++, data: packet };
  }
}
