/** PCM16 一帧的响度，dBFS。数字静音记为 -90。 */
export function dbfs(samples: Int16Array): number {
  if (samples.length === 0) return -90;
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length) / 32768;
  return rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
}

export function concatPcm(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function pcmToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

export function bytesToPcm(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.slice().buffer);
}
