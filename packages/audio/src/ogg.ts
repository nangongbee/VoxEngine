const textDecoder = new TextDecoder();

/**
 * 从 Ogg 流里拆出裸 Opus 包（RFC 7845），可以分块喂。
 * 跳过 OpusHead / OpusTags 头包；跨页的包会拼起来。
 */
export class OggOpusReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private partial: Uint8Array[] = [];

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = concat([this.buffer, chunk]);
    const packets: Uint8Array[] = [];

    while (this.buffer.length >= 27) {
      const start = indexOfOggS(this.buffer);
      if (start < 0) {
        this.buffer = this.buffer.subarray(this.buffer.length - 3);
        break;
      }
      const page = this.buffer.subarray(start);
      const segments = page[26]!;
      const headerSize = 27 + segments;
      if (page.length < headerSize) break;
      const table = page.subarray(27, headerSize);
      const bodySize = table.reduce((sum, n) => sum + n, 0);
      if (page.length < headerSize + bodySize) break;

      let offset = headerSize;
      for (const size of table) {
        this.partial.push(page.subarray(offset, offset + size));
        offset += size;
        if (size < 255) {
          const packet = concat(this.partial);
          this.partial = [];
          if (!isHeader(packet)) packets.push(packet);
        }
      }
      this.buffer = page.subarray(headerSize + bodySize);
    }
    return packets;
  }
}

function isHeader(packet: Uint8Array): boolean {
  if (packet.length < 8) return false;
  const magic = textDecoder.decode(packet.subarray(0, 8));
  return magic === "OpusHead" || magic === "OpusTags";
}

function indexOfOggS(data: Uint8Array): number {
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0x4f && data[i + 1] === 0x67 && data[i + 2] === 0x67 && data[i + 3] === 0x53) return i;
  }
  return -1;
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!.slice();
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
