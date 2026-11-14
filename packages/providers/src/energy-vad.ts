import { dbfs } from "@voxengine/audio";
import type { VoiceActivityDetector } from "./types.ts";

export interface EnergyVadOptions {
  /** 比底噪高多少 dB 算人声。默认 12。 */
  marginDb?: number;
  /** 再小也不算人声的绝对下限。默认 -45 dBFS。 */
  floorDbfs?: number;
}

/**
 * 零依赖的能量门限：跟踪底噪，明显高于底噪就算人声。
 * 它分不清咳嗽、关门和说话；要准就换神经网络 VAD（如 Silero）。每路会话一个实例。
 */
export function energyVad(options: EnergyVadOptions = {}): VoiceActivityDetector {
  const marginDb = options.marginDb ?? 12;
  const floorDbfs = options.floorDbfs ?? -45;
  let noise = -60;
  return {
    name: "energy",
    isSpeech(pcm) {
      const level = dbfs(pcm);
      const speech = level > Math.max(noise + marginDb, floorDbfs);
      if (!speech) noise = noise * 0.95 + level * 0.05;
      return speech;
    },
  };
}
