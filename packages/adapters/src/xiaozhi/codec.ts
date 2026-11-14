import type { AudioFormat, ListenMode } from "@voxengine/protocol";

/** 设备发来的一帧。只列适配器用到的字段。 */
export type DeviceMessage =
  | { type: "audio"; data: Uint8Array }
  | { type: "hello"; purpose?: string; mcp: boolean; audioIn: AudioFormat }
  | { type: "listen"; state: string; mode?: ListenMode; text?: string }
  | { type: "abort"; reason?: string }
  | { type: "text"; text: string }
  | { type: "mcp"; payload: unknown }
  | { type: "ping" }
  | { type: "unknown"; raw: string };

const DEFAULT_AUDIO_IN: AudioFormat = { codec: "opus", sampleRate: 16000, channels: 1, frameMs: 60 };

/**
 * 二进制帧头由 Protocol-Version 头决定：
 * v1 裸 Opus；v2 16 字节（version u16, type u16, reserved u32, timestamp u32, size u32）；
 * v3 4 字节（type u8, reserved u8, size u16）。均为网络字节序。
 */
export function decode(data: string | Uint8Array, version: number): DeviceMessage {
  if (typeof data !== "string") return decodeBinary(data, version);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(data);
  } catch {
    return { type: "unknown", raw: data };
  }
  switch (json.type) {
    case "hello":
      return {
        type: "hello",
        purpose: typeof json.purpose === "string" && json.purpose ? json.purpose : undefined,
        mcp: (json.features as { mcp?: unknown } | undefined)?.mcp === true,
        audioIn: readAudioParams(json.audio_params),
      };
    case "listen":
      return { type: "listen", state: String(json.state), mode: json.mode as ListenMode | undefined, text: json.text as string | undefined };
    case "abort":
      return { type: "abort", reason: json.reason as string | undefined };
    case "text":
      return { type: "text", text: String(json.text ?? "") };
    case "mcp":
      return { type: "mcp", payload: json.payload };
    case "ping":
      return { type: "ping" };
    default:
      return { type: "unknown", raw: data };
  }
}

export function encodeAudio(data: Uint8Array, version: number, timestamp = 0): Uint8Array {
  if (version === 2) {
    const out = new Uint8Array(16 + data.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, 2);
    view.setUint32(8, timestamp);
    view.setUint32(12, data.length);
    out.set(data, 16);
    return out;
  }
  if (version === 3) {
    const out = new Uint8Array(4 + data.length);
    new DataView(out.buffer).setUint16(2, data.length);
    out.set(data, 4);
    return out;
  }
  return data;
}

export function helloAck(sessionId: string, audioOut: AudioFormat, timezoneOffsetMinutes: number) {
  return {
    type: "hello",
    transport: "websocket",
    session_id: sessionId,
    audio_params: {
      format: audioOut.codec,
      sample_rate: audioOut.sampleRate,
      channels: audioOut.channels,
      frame_duration: audioOut.frameMs,
    },
    // timestamp 是 UTC 毫秒；设备自己加上 timezone_offset。
    server_time: { timestamp: Date.now(), timezone_offset: timezoneOffsetMinutes },
  };
}

function decodeBinary(data: Uint8Array, version: number): DeviceMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (version === 2 && data.length >= 16) {
    if (view.getUint16(2) !== 0) return { type: "unknown", raw: "v2 非音频帧" };
    return { type: "audio", data: data.subarray(16, 16 + view.getUint32(12)) };
  }
  if (version === 3 && data.length >= 4) {
    if (view.getUint8(0) !== 0) return { type: "unknown", raw: "v3 非音频帧" };
    return { type: "audio", data: data.subarray(4, 4 + view.getUint16(2)) };
  }
  return { type: "audio", data };
}

function readAudioParams(value: unknown): AudioFormat {
  const params = (value ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number) => (typeof params[key] === "number" ? (params[key] as number) : fallback);
  return {
    codec: params.format === "pcm16" ? "pcm16" : "opus",
    sampleRate: num("sample_rate", DEFAULT_AUDIO_IN.sampleRate),
    channels: num("channels", DEFAULT_AUDIO_IN.channels),
    frameMs: num("frame_duration", DEFAULT_AUDIO_IN.frameMs),
  };
}
