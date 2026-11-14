import type {
  AudioFormat,
  Downlink,
  EngineEvent,
  InterruptSource,
  SessionEndReason,
  SessionTrigger,
  ToolFailure,
  Uplink,
} from "@voxengine/protocol";
import { Player } from "./player.ts";
import type { Profile } from "./profile.ts";
import type { RuntimeEvent, RuntimeSession, RuntimeTool } from "./runtime.ts";
import type { Media, Tool, ToolOutput } from "./tool.ts";

type State = "listening" | "thinking" | "speaking" | "ended";

/** 媒体最多预读这么多还没下发的音频。 */
const MEDIA_BUFFER_MS = 4000;

export interface SessionDeps {
  deviceId: string;
  trigger: SessionTrigger;
  profile: Profile;
  tools: Tool[];
  input: AudioFormat;
  output: AudioFormat;
  leadMs: number;
  send(msg: Downlink): void;
  emit(event: EngineEvent): void;
  onEnded(): void;
}

/** 正在播的一段媒体。 */
interface Playing {
  media: Media;
  turnId: string;
  ms: number;
}

/** 一场对话：状态、轮次、播放、打断、空闲结束；工具的超时、取消和它们要播的音频。 */
export class Session {
  readonly id = crypto.randomUUID();
  private state: State = "listening";
  private turnId = "";
  private turnStartedAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly player: Player;
  private runtime: RuntimeSession;
  /** speaking 时在播的是媒体；undefined 表示在播回复。 */
  private playing: Playing | undefined;
  /** 等着播的媒体，排在当前回复后面。 */
  private queue: { media: Media; turnId: string }[] = [];
  private mediaTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  /** Runtime 已在长媒体播放中关掉；再被打断时重开一个。 */
  private released = false;
  private readonly calls = new Set<AbortController>();

  constructor(private readonly deps: SessionDeps) {
    const { profile, send, emit, deviceId, trigger } = deps;
    send({ type: "session.started", sessionId: this.id });
    send({ type: "listen.set", state: "open" });

    this.player = new Player({
      leadMs: deps.leadMs,
      send: (frame) => send({ type: "audio.out", frame }),
      onDrained: () => this.onPlayed(),
      onStats: (stats) => {
        if (!this.playing) return;
        emit({
          type: "media.progress",
          sessionId: this.id,
          turnId: this.playing.turnId,
          title: this.playing.media.title,
          sentMs: stats.sentMs,
          queuedMs: stats.queuedMs,
          lagMs: stats.lagMs,
        });
      },
    });
    this.runtime = this.openRuntime();
    emit({
      type: "session.started",
      deviceId,
      sessionId: this.id,
      trigger,
      runtime: profile.runtime.name,
      capabilities: { ...this.runtime.capabilities },
    });
    this.armIdle();
  }

  private openRuntime(): RuntimeSession {
    const { profile, tools, input, output } = this.deps;
    return profile.runtime.open({
      sessionId: this.id,
      instructions: profile.instructions ?? "",
      tools: tools.map((tool) => this.wrap(tool)),
      input,
      output,
      acceptUtterance: (text) => this.acceptUtterance(text),
      emit: (event) => this.onRuntime(event),
    });
  }

  receive(msg: Uplink): void {
    if (this.state === "ended") return;
    switch (msg.type) {
      case "audio.in":
        if (this.released) break;
        // 不许插话时，播放期间收到的多半是喇叭回声；送给 Runtime 会被当成新的一句。
        if (this.state === "speaking" && !this.bargeIn()) break;
        this.runtime.pushAudio(msg.frame);
        break;
      case "speech.start":
        this.onSpeechStarted();
        break;
      case "speech.end":
        if (this.state !== "listening") break;
        this.beginTurn();
        this.runtime.endOfSpeech();
        break;
      case "user.text":
        if (this.state === "speaking") this.interrupt("text");
        this.beginTurn();
        this.runtime.pushText(msg.text);
        break;
      case "user.interrupt":
        if (this.state === "speaking") this.interrupt("terminal");
        break;
      case "session.end":
        this.end("user");
        break;
    }
  }

  end(reason: SessionEndReason): void {
    if (this.state === "ended") return;
    this.state = "ended";
    clearTimeout(this.idleTimer);
    clearTimeout(this.mediaTimer);
    clearTimeout(this.releaseTimer);
    const playedMs = this.player.stop();
    if (this.playing) this.mediaEnded(this.playing, "interrupted", playedMs);
    this.dropQueue();
    this.cancelCalls("ended");
    if (!this.released) this.runtime.close();
    if (reason !== "closed") this.deps.send({ type: "session.ended", sessionId: this.id, reason });
    this.deps.emit({ type: "session.ended", deviceId: this.deps.deviceId, sessionId: this.id, reason });
    this.deps.onEnded();
  }

  private onRuntime(event: RuntimeEvent): void {
    const ended = this.state === "ended";
    // 端到端语音的转写和用量常在会话结束后才到，观察者（存档、计费）还要。
    if (ended && event.type !== "transcript" && event.type !== "usage") return;
    const { send, emit } = this.deps;
    const sessionId = this.id;
    switch (event.type) {
      case "speech.started":
        this.onSpeechStarted();
        break;
      case "speech.ended":
        if (this.state === "speaking") this.onSpeechStarted();
        if (this.state === "listening") this.beginTurn();
        break;
      case "transcript": {
        const live = !ended && this.runtime.capabilities.liveTranscripts;
        if (!ended) send({ type: "caption", role: "user", text: event.text, final: event.final });
        emit({
          type: "transcript",
          sessionId,
          turnId: this.turnId || undefined,
          text: event.text,
          final: event.final,
          availability: live ? "live" : "post_call",
        });
        break;
      }
      case "reply.text":
        if (!this.replying()) break;
        send({ type: "caption", role: "assistant", text: event.text, final: true });
        emit({ type: "reply.text", sessionId, turnId: this.turnId, text: event.text });
        break;
      case "audio":
        if (this.state === "thinking") {
          clearTimeout(this.mediaTimer);
          this.state = "speaking";
          send({ type: "play.start", turnId: this.turnId, kind: "reply" });
          emit({ type: "latency", sessionId, turnId: this.turnId, firstAudioMs: Date.now() - this.turnStartedAt });
        }
        if (this.state === "speaking" && !this.playing) this.player.push(event.frame);
        break;
      case "reply.done":
        if (this.state === "speaking" && !this.playing) this.player.finish();
        else if (this.state === "thinking") this.afterReply();
        break;
      case "usage":
        emit({ type: "usage", sessionId, turnId: this.turnId || undefined, usage: event.usage });
        break;
      case "error":
        emit({ type: "error", deviceId: this.deps.deviceId, sessionId, error: event.error });
        if (!event.recoverable) this.end("error");
        break;
    }
  }

  private acceptUtterance(text: string): boolean {
    if (this.state === "ended") return false;
    const playing = this.state === "speaking";
    const accept = this.deps.profile.acceptUtterance;
    if (accept ? accept(text, { playing }) : text.trim() !== "") return true;
    this.deps.emit({ type: "utterance.ignored", sessionId: this.id, text, playing });
    return false;
  }

  /** 在想或在说回复。媒体播放中不算，Runtime 迟到的字幕不发。 */
  private replying(): boolean {
    return this.state === "thinking" || (this.state === "speaking" && !this.playing);
  }

  private onSpeechStarted(): void {
    clearTimeout(this.idleTimer);
    if (this.playing) this.armRelease();
    if (this.state === "speaking" && this.bargeIn()) this.interrupt("speech");
  }

  private bargeIn(): boolean {
    if (this.released || !this.runtime.capabilities.bargeIn) return false;
    return this.playing?.media.bargeIn ?? this.deps.profile.bargeIn !== false;
  }

  private beginTurn(): void {
    clearTimeout(this.idleTimer);
    this.turnId = crypto.randomUUID();
    this.turnStartedAt = Date.now();
    this.state = "thinking";
    this.deps.emit({ type: "turn.started", sessionId: this.id, turnId: this.turnId });
  }

  private interrupt(source: InterruptSource): void {
    const playedMs = this.player.stop();
    const turnId = this.playing?.turnId ?? this.turnId;
    this.deps.send({ type: "play.stop", turnId, reason: "interrupted" });
    if (this.playing) this.mediaEnded(this.playing, "interrupted", playedMs);
    else this.runtime.interrupt(playedMs);
    this.dropQueue();
    this.cancelCalls("interrupted");
    this.deps.emit({ type: "interrupt", sessionId: this.id, turnId, playedMs, source });
    if (this.released) this.reopen();
    this.toListening();
  }

  private onPlayed(): void {
    const media = this.playing;
    this.deps.send({ type: "play.stop", turnId: media?.turnId ?? this.turnId, reason: "done" });
    if (media) this.mediaEnded(media, "done", media.ms);
    if (media?.media.after === "end") return this.end("done");
    this.afterReply();
  }

  /** 回复（或一段媒体）结束：有排队的媒体就接着播，否则回到听。 */
  private afterReply(): void {
    if (this.queue.length > 0) return this.playNext();
    if (this.released) return this.end("done");
    this.toListening();
  }

  private toListening(): void {
    this.state = "listening";
    this.armIdle();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    const ms = this.deps.profile.idleTimeoutMs ?? 30_000;
    if (ms > 0) this.idleTimer = setTimeout(() => this.end("idle"), ms);
  }

  private enqueue(media: Media): void {
    this.queue.push({ media, turnId: this.turnId });
    if (this.state === "speaking") return;
    // 等模型的确认语；它一直不开口（厂商没回、或回复没有音频）就直接播。
    clearTimeout(this.mediaTimer);
    this.mediaTimer = setTimeout(() => {
      if (this.state === "listening" || this.state === "thinking") this.playNext();
    }, this.deps.profile.media?.waitMs ?? 4000);
  }

  private playNext(): void {
    const next = this.queue.shift();
    if (!next) return;
    clearTimeout(this.mediaTimer);
    clearTimeout(this.idleTimer);
    const playing: Playing = { media: next.media, turnId: next.turnId, ms: 0 };
    this.playing = playing;
    this.state = "speaking";
    this.deps.send({ type: "play.start", turnId: next.turnId, kind: "media" });
    this.deps.emit({ type: "media.started", sessionId: this.id, turnId: next.turnId, title: next.media.title });
    this.armRelease();
    void this.feed(playing);
  }

  private async feed(playing: Playing): Promise<void> {
    const { output } = this.deps;
    try {
      for await (const frame of playing.media.frames) {
        if (this.playing !== playing) return;
        const { codec, sampleRate } = frame.format;
        if (codec !== output.codec || sampleRate !== output.sampleRate) {
          throw new Error(`媒体是 ${codec}/${sampleRate}，设备下行要 ${output.codec}/${output.sampleRate}`);
        }
        await this.player.room(MEDIA_BUFFER_MS);
        if (this.playing !== playing) return;
        playing.ms += frame.format.frameMs;
        this.player.push(frame);
      }
      if (this.playing === playing) this.player.finish();
    } catch (err) {
      if (this.playing !== playing) return;
      const error = err instanceof Error ? err : new Error(String(err));
      this.deps.emit({ type: "error", deviceId: this.deps.deviceId, sessionId: this.id, error });
      const playedMs = this.player.stop();
      this.deps.send({ type: "play.stop", turnId: playing.turnId, reason: "done" });
      this.mediaEnded(playing, "error", playedMs);
      this.afterReply();
    }
  }

  private mediaEnded(playing: Playing, reason: "done" | "interrupted" | "error", playedMs: number): void {
    this.playing = undefined;
    clearTimeout(this.releaseTimer);
    const { title } = playing.media;
    this.deps.emit({ type: "media.ended", sessionId: this.id, turnId: playing.turnId, title, playedMs, reason });
  }

  private dropQueue(): void {
    clearTimeout(this.mediaTimer);
    for (const { media } of this.queue) close(media);
    this.queue = [];
  }

  private armRelease(): void {
    clearTimeout(this.releaseTimer);
    const ms = this.deps.profile.media?.releaseRuntimeMs ?? 0;
    if (ms <= 0 || this.released) return;
    this.releaseTimer = setTimeout(() => {
      if (!this.playing || this.state !== "speaking") return;
      this.released = true;
      this.cancelCalls("ended");
      this.runtime.close();
      this.deps.emit({ type: "runtime.released", sessionId: this.id });
    }, ms);
  }

  /** 释放后被唤醒、按键或文字打断：用户要说话了，换一个新的 Runtime 接着听。之前的对话上下文不带过去。 */
  private reopen(): void {
    this.released = false;
    this.runtime = this.openRuntime();
    this.deps.emit({ type: "runtime.reopened", sessionId: this.id });
  }

  private cancelCalls(reason: "interrupted" | "ended"): void {
    for (const call of this.calls) call.abort(reason);
  }

  /** 给 Runtime 的工具：发事件、管超时和取消；结果里的音频留在核心播，只把文字交回。 */
  private wrap(tool: Tool): RuntimeTool {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      invoke: (args) => this.call(tool, args),
    };
  }

  private async call(tool: Tool, args: unknown): Promise<string> {
    const { emit, deviceId, output, profile } = this.deps;
    const sessionId = this.id;
    const callId = crypto.randomUUID();
    const startedAt = Date.now();
    const abort = new AbortController();
    const timeoutMs = tool.timeoutMs ?? profile.toolTimeoutMs ?? 10_000;
    const timer = setTimeout(() => abort.abort("timeout"), timeoutMs);
    this.calls.add(abort);
    emit({ type: "tool.called", sessionId, callId, name: tool.name, args });
    try {
      const result = await untilAborted(tool.invoke(args, { sessionId, deviceId, output, signal: abort.signal }), abort.signal);
      const { content, media } = typeof result === "string" ? { content: result, media: undefined } : result;
      emit({ type: "tool.returned", sessionId, callId, ok: true, content, ms: Date.now() - startedAt });
      if (media) this.enqueue(media);
      return content;
    } catch (err) {
      const reason = abort.signal.aborted ? abort.signal.reason : undefined;
      const failure: ToolFailure = reason === "timeout" ? "timeout" : reason ? "cancelled" : "error";
      const content =
        failure === "timeout"
          ? `工具超时（${timeoutMs} ms）`
          : failure === "cancelled"
            ? "工具已取消"
            : err instanceof Error
              ? err.message
              : String(err);
      emit({ type: "tool.returned", sessionId, callId, ok: false, content, ms: Date.now() - startedAt, failure });
      throw new Error(content);
    } finally {
      clearTimeout(timer);
      this.calls.delete(abort);
    }
  }
}

/** 取消后不再等工具；它晚到的结果里如果带音频，关掉。 */
function untilAborted(promise: Promise<string | ToolOutput>, signal: AbortSignal): Promise<string | ToolOutput> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error(String(signal.reason)));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        if (!signal.aborted) return resolve(result);
        if (typeof result !== "string" && result.media) close(result.media);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function close(media: Media): void {
  void media.frames[Symbol.asyncIterator]().return?.()?.catch(() => {});
}
