import type { Engine, TerminalLink } from "@voxengine/core";
import type { AudioFormat, AudioFrame, Capabilities, Downlink, Uplink } from "@voxengine/protocol";

export const PCM16_16K: AudioFormat = { codec: "pcm16", sampleRate: 16000, channels: 1, frameMs: 20 };

export interface FakeTerminalOptions {
  deviceId?: string;
  capabilities?: Partial<Capabilities>;
}

type DownlinkOf<T extends Downlink["type"]> = Extract<Downlink, { type: T }>;

/** 不用硬件的终端：直接发内部消息，记下收到的所有下行消息。 */
export class FakeTerminal {
  readonly deviceId: string;
  readonly received: Downlink[] = [];
  private readonly link: TerminalLink;
  private readonly audioIn: AudioFormat;
  private cursor = 0;
  private seq = 0;
  private notify = () => {};

  constructor(engine: Engine, options: FakeTerminalOptions = {}) {
    this.deviceId = options.deviceId ?? "fake-device";
    const capabilities: Capabilities = {
      audioIn: PCM16_16K,
      audioOut: [PCM16_16K],
      vad: true,
      wakeOnly: false,
      tools: false,
      ...options.capabilities,
    };
    this.audioIn = capabilities.audioIn;
    this.link = engine.connect((msg) => {
      this.received.push(msg);
      this.notify();
    });
    this.send({ type: "terminal.hello", deviceId: this.deviceId, capabilities });
  }

  send(msg: Uplink): void {
    this.link.send(msg);
  }

  /** 说一段话：speech.start → count 帧静音 → speech.end。 */
  say(count: number): void {
    this.send({ type: "speech.start" });
    for (let i = 0; i < count; i++) this.send({ type: "audio.in", frame: this.silence() });
    this.send({ type: "speech.end" });
  }

  /** 等上一次匹配之后的下一条该类型消息，保证顺序。 */
  waitFor<T extends Downlink["type"]>(type: T, timeoutMs = 2000): Promise<DownlinkOf<T>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = this.received.findIndex((msg, i) => i >= this.cursor && msg.type === type);
        if (index < 0) return false;
        this.cursor = index + 1;
        clearTimeout(timer);
        this.notify = () => {};
        resolve(this.received[index] as DownlinkOf<T>);
        return true;
      };
      const timer = setTimeout(() => {
        this.notify = () => {};
        reject(new Error(`等 ${type} 超时；已收到：${this.received.map((m) => m.type).join(", ")}`));
      }, timeoutMs);
      if (!check()) this.notify = () => void check();
    });
  }

  count(type: Downlink["type"]): number {
    return this.received.filter((msg) => msg.type === type).length;
  }

  private silence(): AudioFrame {
    const { sampleRate, frameMs, channels } = this.audioIn;
    const bytes = ((sampleRate * frameMs) / 1000) * channels * 2;
    return { format: this.audioIn, seq: this.seq++, data: new Uint8Array(bytes) };
  }
}
