import type {
  Capabilities,
  Downlink,
  EngineEvent,
  SessionEndReason,
  SessionTrigger,
  ToolSpec,
  Uplink,
} from "@voxengine/protocol";
import type { Profile } from "./profile.ts";
import { Session } from "./session.ts";
import type { Tool } from "./tool.ts";

export interface TerminalDeps {
  profile: Profile;
  leadMs: number;
  send(msg: Downlink): void;
  emit(event: EngineEvent): void;
  onClosed(): void;
}

interface PendingCall {
  resolve(content: string): void;
  reject(err: Error): void;
  /** 不再听取消信号。 */
  release(): void;
}

/** 一台在线设备。同一时间最多一场会话；设备工具调用也走这里。 */
export class Terminal {
  readonly id = crypto.randomUUID();
  private session: Session | undefined;
  private deviceTools: ToolSpec[] = [];
  private readonly pending = new Map<string, PendingCall>();
  private closed = false;

  constructor(
    readonly deviceId: string,
    private readonly capabilities: Capabilities,
    private readonly deps: TerminalDeps,
  ) {
    const audioOut = capabilities.audioOut[0];
    if (!audioOut) throw new Error(`设备 ${deviceId} 没有声明 audioOut`);
    deps.send({ type: "terminal.ready", terminalId: this.id, audioOut });
    deps.emit({ type: "terminal.ready", deviceId, terminalId: this.id });
  }

  receive(msg: Uplink): void {
    if (this.closed) return;
    switch (msg.type) {
      case "tool.list":
        this.deviceTools = msg.tools;
        break;
      case "tool.result":
        this.settle(msg.callId, msg.ok, msg.content);
        break;
      case "session.start":
        this.session ??= this.openSession(msg.trigger);
        break;
      case "user.text":
        this.session ??= this.openSession("text");
        this.session.receive(msg);
        break;
      case "terminal.bye":
        this.close("closed");
        break;
      default:
        this.session?.receive(msg);
    }
  }

  close(reason: SessionEndReason): void {
    if (this.closed) return;
    this.closed = true;
    this.session?.end(reason);
    for (const [callId, call] of this.pending) {
      call.release();
      call.reject(new Error(`设备已断开，工具调用 ${callId} 作废`));
    }
    this.pending.clear();
    this.deps.emit({ type: "terminal.closed", deviceId: this.deviceId, terminalId: this.id, reason });
    this.deps.onClosed();
  }

  private openSession(trigger: SessionTrigger): Session {
    const { profile } = this.deps;
    const deviceTools = profile.deviceTools ? profile.deviceTools(this.deviceTools) : this.deviceTools;
    const session = new Session({
      deviceId: this.deviceId,
      trigger,
      profile,
      tools: [...(profile.tools ?? []), ...deviceTools.map((spec) => this.deviceTool(spec))],
      input: this.capabilities.audioIn,
      output: this.capabilities.audioOut[0]!,
      leadMs: this.deps.leadMs,
      send: this.deps.send,
      emit: this.deps.emit,
      onEnded: () => {
        if (this.session === session) this.session = undefined;
      },
    });
    return session;
  }

  /** 超时、取消由会话统一管；这里只在取消时丢掉等待中的调用。 */
  private deviceTool(spec: ToolSpec): Tool {
    return {
      ...spec,
      invoke: (args, { signal }) =>
        new Promise((resolve, reject) => {
          const callId = crypto.randomUUID();
          const cancel = () => {
            this.pending.delete(callId);
            reject(new Error(`设备工具 ${spec.name} 已取消`));
          };
          signal.addEventListener("abort", cancel, { once: true });
          const release = () => signal.removeEventListener("abort", cancel);
          this.pending.set(callId, { resolve, reject, release });
          this.deps.send({ type: "tool.call", callId, name: spec.name, args });
        }),
    };
  }

  private settle(callId: string, ok: boolean, content: string): void {
    const call = this.pending.get(callId);
    if (!call) return;
    this.pending.delete(callId);
    call.release();
    if (ok) call.resolve(content);
    else call.reject(new Error(content));
  }
}
