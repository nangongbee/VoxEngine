import type { AudioFrame } from "@voxengine/protocol";

export interface PlayerOptions {
  /**
   * 保留给停止时估算「设备里还没播完的余量」。
   * 下发节奏不用它：旧网关没有超前量，按墙钟每帧一包。
   */
  leadMs: number;
  send(frame: AudioFrame): void;
  /** finish() 之后队列抽空时调用。 */
  onDrained(): void;
  /** 约每 2 秒一次：lagMs>0 表示下发落后于墙钟。 */
  onStats?: (stats: PlayerStats) => void;
}

export interface PlayerStats {
  sentMs: number;
  queuedMs: number;
  queueLength: number;
  /** 墙钟已走过 − 已下发；>0 掉队。 */
  lagMs: number;
}

/**
 * 与旧网关 drainTick 相同：5ms 定时器，target = 已经过的帧槽，每槽一包。
 * 队列空才冻结时钟。落后只补真正错过的槽，不会每拍按 lead 再灌一截。
 */
export class Player {
  private queue: AudioFrame[] = [];
  private queuedMs = 0;
  private waiters: { maxMs: number; resolve: () => void }[] = [];
  private sentMs = 0;
  private finishing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startMs = 0;
  private lastStatsAt = 0;

  constructor(private readonly options: PlayerOptions) {}

  get playing(): boolean {
    return this.sentMs > 0 || this.queue.length > 0 || this.timer !== undefined;
  }

  push(frame: AudioFrame): void {
    this.queue.push(frame);
    this.queuedMs += frame.format.frameMs;
    this.ensureTimer();
  }

  /** 还没下发的积压少于 maxMs 时返回；停止时也返回。 */
  room(maxMs: number): Promise<void> {
    if (this.queuedMs < maxMs) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ maxMs, resolve }));
  }

  finish(): void {
    this.finishing = true;
    this.ensureTimer();
  }

  /** 停止并清空，返回已下发的毫秒数（与旧网关 packetsSent×20 一致）。 */
  stop(): number {
    const played = this.sentMs;
    this.reset();
    return Math.max(0, played);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.startMs = Date.now();
    this.lastStatsAt = this.startMs;
    this.timer = setInterval(this.tick, 5);
  }

  private tick = (): void => {
    const now = Date.now();
    if (this.queue.length === 0 && !this.finishing) {
      this.startMs = now - this.sentMs;
      this.wake(false);
      this.maybeStats(now);
      return;
    }

    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      const frameMs = next.format.frameMs;
      if (this.sentMs + frameMs > now - this.startMs) break;
      this.queue.shift();
      this.queuedMs -= frameMs;
      this.sentMs += frameMs;
      this.options.send(next);
    }

    this.wake(false);
    this.maybeStats(now);

    if (this.queue.length === 0 && this.finishing) {
      const onDrained = this.options.onDrained;
      this.reset();
      onDrained();
    }
  };

  private maybeStats(now: number): void {
    if (!this.options.onStats || now - this.lastStatsAt < 2000) return;
    this.lastStatsAt = now;
    this.options.onStats({
      sentMs: this.sentMs,
      queuedMs: this.queuedMs,
      queueLength: this.queue.length,
      lagMs: now - this.startMs - this.sentMs,
    });
  }

  private wake(all: boolean): void {
    const ready = this.waiters.filter((w) => all || this.queuedMs < w.maxMs);
    if (ready.length === 0) return;
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
  }

  private reset(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.queue = [];
    this.queuedMs = 0;
    this.wake(true);
    this.sentMs = 0;
    this.startMs = 0;
    this.finishing = false;
    this.lastStatsAt = 0;
  }
}
