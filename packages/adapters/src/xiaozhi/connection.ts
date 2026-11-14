import type { Engine, TerminalLink } from "@voxengine/core";
import type { AudioFormat, Downlink } from "@voxengine/protocol";
import { decode, encodeAudio, helloAck, type DeviceMessage } from "./codec.ts";
import { DeviceMcp } from "./mcp.ts";

/** 网关给适配器的一条 WebSocket，和具体服务器实现无关。 */
export interface XiaozhiSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

/** 来自升级请求的头：Device-Id、Protocol-Version。 */
export interface XiaozhiHeaders {
  deviceId: string;
  version: number;
}

export interface XiaozhiOptions {
  /** 下行格式。默认和设备上行相同（回声直通）；接豆包实时一般是 opus 24000 Hz / 20 ms。 */
  audioOut?: AudioFormat;
  /** 设备钟表时区，分钟。默认取网关所在时区。 */
  timezoneOffsetMinutes?: number;
  /** 设备 MCP 请求超时。默认 5 秒。 */
  mcpTimeoutMs?: number;
}

/**
 * 小智 `/chat` 的一条连接：设备协议 ↔ 内部协议。
 * 一条 `/chat` 就是一场对话；会话结束时关连接，设备回到待机。
 */
export class XiaozhiConnection {
  private link: TerminalLink | undefined;
  private mcp: DeviceMcp | undefined;
  private audioIn: AudioFormat | undefined;
  private readonly sessionId = crypto.randomUUID();
  private seq = 0;
  private closed = false;

  constructor(
    private readonly engine: Engine,
    private readonly socket: XiaozhiSocket,
    private readonly headers: XiaozhiHeaders,
    private readonly options: XiaozhiOptions = {},
  ) {}

  receive(data: string | Uint8Array): void {
    if (this.closed) return;
    const msg = decode(data, this.headers.version);
    if (msg.type === "hello") return this.hello(msg);
    if (msg.type === "ping") return this.json({ type: "ping" });
    if (msg.type === "mcp") return this.mcp?.handle(msg.payload);
    if (!this.link || !this.audioIn) return;

    const link = this.link;
    switch (msg.type) {
      case "audio":
        link.send({ type: "audio.in", frame: { format: this.audioIn, seq: this.seq++, data: msg.data } });
        break;
      case "listen":
        this.listen(link, msg);
        break;
      case "abort":
        link.send({ type: "user.interrupt", reason: msg.reason });
        break;
      case "text":
        link.send({ type: "user.text", text: msg.text });
        break;
    }
  }

  /** 设备断开。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mcp?.close();
    this.link?.send({ type: "terminal.bye", reason: "socket closed" });
  }

  private hello(msg: Extract<DeviceMessage, { type: "hello" }>): void {
    if (msg.purpose) {
      this.socket.close();
      return;
    }
    this.audioIn = msg.audioIn;
    this.link = this.engine.connect((down) => this.downlink(down));
    this.link.send({
      type: "terminal.hello",
      deviceId: this.headers.deviceId,
      capabilities: {
        audioIn: msg.audioIn,
        audioOut: [this.options.audioOut ?? msg.audioIn],
        vad: false,
        wakeOnly: true,
        tools: msg.mcp,
      },
    });
    if (msg.mcp) this.startMcp(this.link);
  }

  private listen(link: TerminalLink, msg: Extract<DeviceMessage, { type: "listen" }>): void {
    switch (msg.state) {
      case "detect":
        link.send({ type: "session.start", trigger: "wake", wakeWord: msg.text });
        break;
      case "start":
        link.send({ type: "session.start", trigger: "button", listenMode: msg.mode });
        break;
      case "stop":
      case "vad_end":
        link.send({ type: "speech.end" });
        break;
      // 不转 vad_start：固件播放时也在跑本地 VAD，会被自己的喇叭触发，当成插话就会自己打断自己。
      // 插话交给 Runtime（服务端或级联的 VAD）和设备按键。
    }
  }

  private downlink(msg: Downlink): void {
    if (this.closed) return;
    switch (msg.type) {
      case "terminal.ready":
        this.json(helloAck(this.sessionId, msg.audioOut, this.options.timezoneOffsetMinutes ?? -new Date().getTimezoneOffset()));
        break;
      case "listen.set":
        if (msg.state === "wake_only") this.json({ type: "listen", state: "wake_only" });
        break;
      case "play.start":
        this.json({ type: "tts", state: "start" });
        break;
      case "audio.out":
        this.socket.send(encodeAudio(msg.frame.data, this.headers.version));
        break;
      case "caption":
        if (msg.role === "user") this.json({ type: "stt", text: msg.text });
        else this.json({ type: "tts", state: "sentence_start", text: msg.text });
        break;
      case "play.stop":
        this.json(msg.reason === "interrupted" ? { type: "tts", state: "stop", reason: "interrupt" } : { type: "tts", state: "stop" });
        break;
      case "tool.call":
        this.callTool(msg.callId, msg.name, msg.args);
        break;
      case "session.ended":
        queueMicrotask(() => {
          this.close();
          this.socket.close();
        });
        break;
    }
  }

  private startMcp(link: TerminalLink): void {
    const mcp = new DeviceMcp((payload) => this.json({ type: "mcp", payload }), this.options.mcpTimeoutMs);
    this.mcp = mcp;
    mcp.listTools().then(
      (tools) => link.send({ type: "tool.list", tools }),
      () => {},
    );
  }

  private callTool(callId: string, name: string, args: unknown): void {
    const link = this.link;
    if (!this.mcp || !link) return;
    this.mcp.call(name, args).then(
      (content) => link.send({ type: "tool.result", callId, ok: true, content }),
      (err: Error) => link.send({ type: "tool.result", callId, ok: false, content: err.message }),
    );
  }

  private json(message: object): void {
    this.socket.send(JSON.stringify(message));
  }
}
