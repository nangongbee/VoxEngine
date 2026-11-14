import { OggOpusReader, opusPacketMs } from "@voxengine/audio";
import type { AudioFormat } from "@voxengine/protocol";
import { ensureOk, lines } from "../lines.ts";
import type { SpeechChunk, TextToSpeech } from "../types.ts";
import { authHeaders, type DoubaoAuth } from "./auth.ts";

const SAMPLE_RATE = 24000;

export interface DoubaoTtsOptions extends DoubaoAuth {
  /** 合成 2.0 的音色，如 zh_female_vv_uranus_bigtts。实时对话的 *_jupiter_bigtts 在这里不能用。 */
  speaker: string;
  url?: string;
  resourceId?: string;
}

/** 下行格式：Opus 24 kHz 单声道 20 ms。终端的 audioOut 要配成这个。 */
export const DOUBAO_TTS_FORMAT: AudioFormat = { codec: "opus", sampleRate: SAMPLE_RATE, channels: 1, frameMs: 20 };

/** 豆包单向流式合成：一句文字，边合成边吐 Opus 包。 */
export function doubaoTts(options: DoubaoTtsOptions): TextToSpeech {
  const url = options.url ?? "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
  const resourceId = options.resourceId ?? "seed-tts-2.0";

  return {
    name: "doubao-tts",
    format: DOUBAO_TTS_FORMAT,
    async *synthesize(text, signal) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Resource-Id": resourceId,
          "X-Api-Request-Id": crypto.randomUUID(),
          ...authHeaders(options, "X-Api-App-Id"),
        },
        body: JSON.stringify({
          user: { uid: "voxengine" },
          req_params: { text, speaker: options.speaker, audio_params: { format: "ogg_opus", sample_rate: SAMPLE_RATE } },
        }),
        signal,
      });
      await ensureOk(response, "豆包合成");

      const reader = new OggOpusReader();
      let seq = 0;
      for await (const line of lines(response.body!)) {
        const json = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!json.startsWith("{")) continue;
        const message = JSON.parse(json) as { code?: number; message?: string; data?: string };
        const code = message.code ?? 0;
        if (code !== 0 && code !== 20000000) throw new Error(`豆包合成出错 ${code} ${message.message ?? ""}`);
        if (!message.data) continue;
        for (const packet of reader.push(Buffer.from(message.data, "base64"))) {
          const frame = { format: { ...DOUBAO_TTS_FORMAT, frameMs: opusPacketMs(packet) }, seq: seq++, data: packet };
          yield { type: "audio", frame } satisfies SpeechChunk;
        }
      }
      yield { type: "usage", usage: [{ provider: "doubao-tts", unit: "tts_chars", units: text.length, estimated: false }] };
    },
  };
}
