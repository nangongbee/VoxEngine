import { concatPcm } from "@voxengine/audio";
import type { VoiceActivityDetector } from "@voxengine/providers";

export interface EndpointOptions {
  /** 静音多久算说完。默认 700 ms。 */
  silenceMs?: number;
  /** 至少说这么久才算开口，挡掉咳嗽、敲桌子。默认 200 ms。 */
  minSpeechMs?: number;
  /** 开口前补多少音频进来，VAD 总是晚一点才判出开口。默认 300 ms。 */
  preRollMs?: number;
  /** 一句最长多久，超过强制切。默认 15 秒。 */
  maxUtteranceMs?: number;
}

export interface TurnTakerHandlers {
  onSpeechStart(): void;
  onUtterance(pcm: Int16Array): void;
}

interface Frame {
  pcm: Int16Array;
  ms: number;
}

/** 一个 VAD 加两个判断：什么时候开口（用于打断）、什么时候说完（切出一句交给识别）。 */
export class TurnTaker {
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly preRollMs: number;
  private readonly maxUtteranceMs: number;
  private preRoll: Frame[] = [];
  private utterance: Frame[] = [];
  private speechMs = 0;
  private quietMs = 0;
  private started = false;

  constructor(
    private readonly vad: VoiceActivityDetector,
    private readonly sampleRate: number,
    private readonly handlers: TurnTakerHandlers,
    options: EndpointOptions = {},
  ) {
    this.silenceMs = options.silenceMs ?? 700;
    this.minSpeechMs = options.minSpeechMs ?? 200;
    this.preRollMs = options.preRollMs ?? 300;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 15_000;
  }

  push(pcm: Int16Array, ms: number): void {
    const frame = { pcm, ms };
    const speech = this.vad.isSpeech(pcm, this.sampleRate);

    if (this.utterance.length === 0) {
      if (!speech) return this.remember(frame);
      this.utterance = [...this.preRoll, frame];
      this.preRoll = [];
      this.speechMs = ms;
      this.quietMs = 0;
      return;
    }

    this.utterance.push(frame);
    if (speech) {
      this.speechMs += ms;
      this.quietMs = 0;
    } else {
      this.quietMs += ms;
    }
    if (!this.started && this.speechMs >= this.minSpeechMs) {
      this.started = true;
      this.handlers.onSpeechStart();
    }
    if (this.quietMs >= this.silenceMs) {
      if (this.started) this.deliver();
      else this.reset();
    } else if (this.duration() >= this.maxUtteranceMs) {
      this.deliver();
    }
  }

  /** 交出正在说的这句。返回有没有交出东西。 */
  flush(): boolean {
    if (!this.started) {
      this.reset();
      return false;
    }
    this.deliver();
    return true;
  }

  reset(): void {
    this.utterance = [];
    this.speechMs = 0;
    this.quietMs = 0;
    this.started = false;
  }

  private deliver(): void {
    const pcm = concatPcm(this.utterance.map((f) => f.pcm));
    this.reset();
    this.handlers.onUtterance(pcm);
  }

  private remember(frame: Frame): void {
    this.preRoll.push(frame);
    let total = this.preRoll.reduce((n, f) => n + f.ms, 0);
    while (total > this.preRollMs && this.preRoll.length > 1) total -= this.preRoll.shift()!.ms;
  }

  private duration(): number {
    return this.utterance.reduce((n, f) => n + f.ms, 0);
  }
}
