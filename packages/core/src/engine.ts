import type { Downlink, EngineEvent, Uplink } from "@voxengine/protocol";
import type { Profile } from "./profile.ts";
import { Terminal } from "./terminal.ts";

export interface EngineOptions {
  /** 固定一个助手，或按设备选。 */
  profile: Profile | ((deviceId: string) => Profile);
  /** 下行音频最多领先设备播放多少毫秒。默认 60。 */
  leadMs?: number;
}

/** 适配器拿到的一条终端链路。第一条消息必须是 `terminal.hello`。 */
export interface TerminalLink {
  send(msg: Uplink): void;
}

export interface Engine {
  connect(sink: (msg: Downlink) => void): TerminalLink;
  on(listener: (event: EngineEvent) => void): () => void;
  close(): void;
}

export function createEngine(options: EngineOptions): Engine {
  const listeners = new Set<(event: EngineEvent) => void>();
  const terminals = new Map<string, Terminal>();
  const profileFor = typeof options.profile === "function" ? options.profile : () => options.profile as Profile;
  const emit = (event: EngineEvent) => {
    for (const listener of listeners) listener(event);
  };

  function open(deviceId: string, msg: Extract<Uplink, { type: "terminal.hello" }>, sink: (msg: Downlink) => void) {
    terminals.get(deviceId)?.close("replaced");
    const terminal: Terminal = new Terminal(deviceId, msg.capabilities, {
      profile: profileFor(deviceId),
      leadMs: options.leadMs ?? 60,
      send: sink,
      emit,
      onClosed: () => {
        if (terminals.get(deviceId) === terminal) terminals.delete(deviceId);
      },
    });
    terminals.set(deviceId, terminal);
    return terminal;
  }

  return {
    connect(sink) {
      let terminal: Terminal | undefined;
      return {
        send(msg) {
          if (msg.type === "terminal.hello") {
            terminal?.close("replaced");
            terminal = open(msg.deviceId, msg, sink);
          } else if (!terminal) {
            throw new Error(`第一条消息必须是 terminal.hello，收到 ${msg.type}`);
          } else {
            terminal.receive(msg);
          }
        },
      };
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      for (const terminal of terminals.values()) terminal.close("closed");
    },
  };
}
