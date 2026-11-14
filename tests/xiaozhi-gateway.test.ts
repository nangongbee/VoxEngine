import { afterEach, expect, test } from "bun:test";
import type { Runtime, RuntimeTool } from "@voxengine/core";
import { startGateway, type Gateway } from "@voxengine/gateway";
import type { EngineEvent } from "@voxengine/protocol";
import { echoRuntime } from "@voxengine/runtimes/echo";

let gateway: Gateway;
afterEach(() => gateway?.stop());

/** 按固件 websocket_protocol.cc 的行为模拟一台小智设备。 */
class FakeDevice {
  readonly json: Record<string, any>[] = [];
  readonly audio: Uint8Array[] = [];
  closed = false;
  private readonly ws: WebSocket;
  private waiters: (() => void)[] = [];

  constructor(port: number, deviceId = "aa:bb:cc:dd:ee:ff") {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/chat`, {
      headers: { "Device-Id": deviceId, "Protocol-Version": "1" },
    } as any);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => {
      if (typeof e.data === "string") this.json.push(JSON.parse(e.data));
      else this.audio.push(new Uint8Array(e.data));
      this.waiters.forEach((w) => w());
    };
    this.ws.onclose = () => {
      this.closed = true;
      this.waiters.forEach((w) => w());
    };
  }

  opened(): Promise<void> {
    return new Promise((resolve) => (this.ws.onopen = () => resolve()));
  }

  send(message: object | Uint8Array): void {
    this.ws.send(message instanceof Uint8Array ? message : JSON.stringify(message));
  }

  hello(mcp = false): void {
    this.send({
      type: "hello",
      version: 1,
      features: { mcp },
      transport: "websocket",
      audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
    });
  }

  until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => reject(new Error(`超时；已收到 ${JSON.stringify(this.json)}`)), timeoutMs);
      this.waiters.push(check);
      check();
    });
  }

  find(type: string, state?: string) {
    return this.json.find((m) => m.type === type && (state === undefined || m.state === state));
  }
}

function start(turnMs = 300, idleTimeoutMs = 30_000) {
  gateway = startGateway({ port: 0, profile: { runtime: echoRuntime({ turnMs }), idleTimeoutMs } });
  const events: EngineEvent[] = [];
  gateway.engine.on((e) => events.push(e));
  return events;
}

test("握手：hello ack 带 session_id、下行音频参数、服务器时间", async () => {
  start();
  const device = new FakeDevice(gateway.port);
  await device.opened();
  device.hello();
  await device.until(() => !!device.find("hello"));

  const ack = device.find("hello")!;
  expect(ack.transport).toBe("websocket");
  expect(typeof ack.session_id).toBe("string");
  expect(ack.audio_params).toEqual({ format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 });
  expect(typeof ack.server_time.timestamp).toBe("number");
});

test("唤醒 → 说话 → tts start / 字幕 / Opus 回放 / tts stop", async () => {
  const events = start(300);
  const device = new FakeDevice(gateway.port);
  await device.opened();
  device.hello();
  await device.until(() => !!device.find("hello"));

  device.send({ type: "listen", state: "detect", text: "你好小智" });
  device.send({ type: "listen", state: "start", mode: "auto" });
  for (let i = 0; i < 5; i++) device.send(new Uint8Array([0xf8, i]));

  await device.until(() => !!device.find("tts", "stop"));
  expect(device.find("tts", "start")).toBeDefined();
  expect(device.find("stt")?.text).toBe("[5 帧音频]");
  expect(device.find("tts", "sentence_start")?.text).toBe("回放 5 帧");
  expect(device.audio.map((a) => a[1])).toEqual([0, 1, 2, 3, 4]);
  expect(events.find((e) => e.type === "session.started")).toMatchObject({ trigger: "wake" });
});

test("设备 abort → tts stop reason interrupt", async () => {
  start(3000);
  const device = new FakeDevice(gateway.port);
  await device.opened();
  device.hello();
  device.send({ type: "listen", state: "start", mode: "auto" });
  for (let i = 0; i < 50; i++) device.send(new Uint8Array([0xf8, i]));
  await device.until(() => !!device.find("tts", "start"));

  device.send({ type: "abort", reason: "wake_word_detected" });
  await device.until(() => !!device.find("tts", "stop"));
  expect(device.find("tts", "stop")?.reason).toBe("interrupt");
  expect(device.audio.length).toBeLessThan(50);
});

test("播放时设备的 vad_start 不算插话（多半是自己喇叭的声音）", async () => {
  const events = start(600);
  const device = new FakeDevice(gateway.port);
  await device.opened();
  device.hello();
  device.send({ type: "listen", state: "start", mode: "realtime" });
  for (let i = 0; i < 10; i++) device.send(new Uint8Array([0xf8, i]));
  await device.until(() => !!device.find("tts", "start"));

  device.send({ type: "listen", state: "vad_start" });
  await device.until(() => !!device.find("tts", "stop"));
  expect(device.find("tts", "stop")?.reason).toBeUndefined();
  expect(events.some((e) => e.type === "interrupt")).toBe(false);
});

test("空闲超时：服务器关掉 /chat，终端下线", async () => {
  const events = start(300, 100);
  const device = new FakeDevice(gateway.port);
  await device.opened();
  device.hello();
  device.send({ type: "listen", state: "start", mode: "auto" });

  await device.until(() => device.closed);
  await Bun.sleep(20);
  expect(events.map((e) => e.type)).toEqual(["terminal.ready", "session.started", "session.ended", "terminal.closed"]);
});

test("设备 MCP：initialize → tools/list → Runtime 调用 → tools/call", async () => {
  let tools: RuntimeTool[] = [];
  const captureTools: Runtime = {
    name: "capture-tools",
    open(ctx) {
      tools = ctx.tools;
      return {
        capabilities: { liveTranscripts: true, tools: true, bargeIn: true },
        pushAudio() {},
        pushText() {},
        endOfSpeech() {},
        interrupt() {},
        close() {},
      };
    },
  };
  gateway = startGateway({ port: 0, profile: { runtime: captureTools } });
  const device = new FakeDevice(gateway.port);
  await device.opened();
  device.hello(true);

  await device.until(() => device.json.some((m) => m.type === "mcp" && m.payload.method === "initialize"));
  const init = device.json.find((m) => m.payload?.method === "initialize")!;
  device.send({ type: "mcp", payload: { jsonrpc: "2.0", id: init.payload.id, result: { serverInfo: { name: "box3" } } } });

  await device.until(() => device.json.some((m) => m.payload?.method === "tools/list"));
  const list = device.json.find((m) => m.payload?.method === "tools/list")!;
  device.send({
    type: "mcp",
    payload: {
      jsonrpc: "2.0",
      id: list.payload.id,
      result: {
        tools: [
          { name: "self.audio_speaker.set_volume", description: "设音量", inputSchema: { type: "object" } },
          { name: "self.reboot", description: "重启", inputSchema: {}, annotations: { audience: ["user"] } },
        ],
      },
    },
  });
  await Bun.sleep(20);
  device.send({ type: "listen", state: "start", mode: "auto" });
  await Bun.sleep(20);
  expect(tools.map((t) => t.name)).toEqual(["self.audio_speaker.set_volume"]);

  const result = tools[0]!.invoke({ volume: 30 });
  await device.until(() => device.json.some((m) => m.payload?.method === "tools/call"));
  const call = device.json.find((m) => m.payload?.method === "tools/call")!;
  expect(call.payload.params).toEqual({ name: "self.audio_speaker.set_volume", arguments: { volume: 30 } });
  device.send({
    type: "mcp",
    payload: { jsonrpc: "2.0", id: call.payload.id, result: { content: [{ type: "text", text: "true" }] } },
  });
  expect(await result).toBe("true");
});

test("产品路由：HTTP 交给 fetch，WebSocket 按路径交给 sockets，其余 404", async () => {
  const received: string[] = [];
  gateway = startGateway({
    port: 0,
    profile: { runtime: echoRuntime() },
    fetch: (req) => (new URL(req.url).pathname === "/api/ping" ? new Response("pong") : undefined),
    sockets: {
      "/push": (socket) => {
        socket.send(`hi ${socket.headers.get("device-id")}`);
        return { message: (data) => received.push(String(data)) };
      },
    },
  });
  const base = `http://127.0.0.1:${gateway.port}`;
  expect(await (await fetch(`${base}/api/ping`)).text()).toBe("pong");
  expect((await fetch(`${base}/nope`)).status).toBe(404);

  const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/push`, { headers: { "Device-Id": "dev-1" } } as any);
  const greeting = await new Promise<string>((resolve) => (ws.onmessage = (e) => resolve(String(e.data))));
  expect(greeting).toBe("hi dev-1");
  ws.send("ping");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(received).toEqual(["ping"]);
  ws.close();
});
