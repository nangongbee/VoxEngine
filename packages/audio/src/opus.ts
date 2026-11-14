import OpusScript from "opusscript";

const SILK_MS = [10, 20, 40, 60];
const HYBRID_MS = [10, 20];
const CELT_MS = [2.5, 5, 10, 20];

/** 按 TOC 字节（RFC 6716 §3.1）算一个 Opus 包有多少毫秒。 */
export function opusPacketMs(packet: Uint8Array): number {
  const toc = packet[0] ?? 0;
  const config = toc >> 3;
  const frameMs = config < 12 ? SILK_MS[config % 4]! : config < 16 ? HYBRID_MS[config % 2]! : CELT_MS[config % 4]!;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  return frameMs * frames;
}

/** Opus → PCM16。一路音频一个实例，用完 destroy。 */
export class OpusDecoder {
  private readonly decoder: OpusScript;

  constructor(sampleRate: 8000 | 12000 | 16000 | 24000 | 48000, channels = 1) {
    this.decoder = new OpusScript(sampleRate, channels);
  }

  decode(packet: Uint8Array): Int16Array {
    const out = this.decoder.decode(Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength));
    return new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2).slice();
  }

  destroy(): void {
    this.decoder.delete();
  }
}
