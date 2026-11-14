export type AudioCodec = "opus" | "pcm16";

export interface AudioFormat {
  codec: AudioCodec;
  sampleRate: number;
  channels: number;
  frameMs: number;
}

export interface AudioFrame {
  format: AudioFormat;
  /** 同一终端同一方向单调递增。 */
  seq: number;
  data: Uint8Array;
}
