import { pcmToBytes } from "@voxengine/audio";
import { ensureOk } from "../lines.ts";
import type { SpeechToText } from "../types.ts";
import { authHeaders, type DoubaoAuth } from "./auth.ts";

const OK = "20000000";
const SILENCE = "20000003";

export interface DoubaoAsrOptions extends DoubaoAuth {
  url?: string;
  resourceId?: string;
}

/** 豆包录音文件极速识别：一整句 PCM 一次请求，约 0.5 秒返回。 */
export function doubaoAsr(options: DoubaoAsrOptions): SpeechToText {
  const url = options.url ?? "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
  const resourceId = options.resourceId ?? "volc.seedasr.auc";

  return {
    name: "doubao-asr",
    async transcribe({ pcm, sampleRate }, signal) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Resource-Id": resourceId,
          "X-Api-Request-Id": crypto.randomUUID(),
          "X-Api-Sequence": "-1",
          ...authHeaders(options, "X-Api-App-Key"),
        },
        body: JSON.stringify({
          user: { uid: "voxengine" },
          audio: { data: Buffer.from(pcmToBytes(pcm)).toString("base64"), format: "pcm", rate: sampleRate, bits: 16, channel: 1 },
          request: { model_name: "bigmodel", enable_punc: true, enable_itn: true },
        }),
        signal,
      });
      const status = response.headers.get("X-Api-Status-Code");
      const audioMs = Math.round((pcm.length / sampleRate) * 1000);
      const usage = [{ provider: "doubao-asr", unit: "audio_ms", units: audioMs, estimated: false }];
      if (status === SILENCE) return { text: "", usage };
      await ensureOk(response, "豆包识别");
      if (status !== OK) throw new Error(`豆包识别 status ${status} ${(await response.text()).slice(0, 240)}`);
      const body = (await response.json()) as { result?: { text?: string } };
      return { text: body.result?.text?.trim() ?? "", usage };
    },
  };
}
