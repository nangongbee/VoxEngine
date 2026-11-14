import type { Engine } from "@voxengine/core";
import type { EngineEvent } from "@voxengine/protocol";

/** 把引擎事件打成一行一条的日志。音频帧级的事件不打。 */
export function logEvents(engine: Engine, write: (line: string) => void = console.log): () => void {
  return engine.on((event) => write(`${new Date().toISOString()} ${format(event)}`));
}

function format(event: EngineEvent): string {
  const short = (id: string | undefined) => id?.slice(0, 8) ?? "-";
  switch (event.type) {
    case "terminal.ready":
      return `终端上线 ${event.deviceId}`;
    case "terminal.closed":
      return `终端下线 ${event.deviceId} (${event.reason})`;
    case "session.started":
      return `会话开始 ${short(event.sessionId)} ${event.deviceId} (${event.trigger}) ${event.runtime}`;
    case "session.ended":
      return `会话结束 ${short(event.sessionId)} (${event.reason})`;
    case "turn.started":
      return `新一轮   ${short(event.turnId)}`;
    case "transcript":
      return `用户     ${event.text}${event.final ? "" : " …"}${event.availability === "post_call" ? "（事后补）" : ""}`;
    case "utterance.ignored":
      return `忽略     ${event.text || "（空）"}${event.playing ? "（播放中）" : ""}`;
    case "reply.text":
      return `助手     ${event.text}`;
    case "latency":
      return `首包延迟 ${event.firstAudioMs} ms`;
    case "interrupt":
      return `被打断   已播 ${event.playedMs} ms（${event.source}）`;
    case "tool.called":
      return `调工具   ${event.name} ${JSON.stringify(event.args)}`;
    case "tool.returned":
      return `工具返回 ${event.ok ? "成功" : `失败(${event.failure})`} ${event.ms} ms ${event.content.slice(0, 80)}`;
    case "media.started":
      return `开始播放 ${event.title ?? "媒体"}`;
    case "media.progress":
      return `播放进度 ${event.title ?? "媒体"} 已下发 ${event.sentMs} ms 队列 ${event.queuedMs} ms 偏差 ${event.lagMs} ms`;
    case "media.ended":
      return `播放结束 ${event.title ?? "媒体"} 已播 ${event.playedMs} ms（${event.reason}）`;
    case "runtime.released":
      return `释放 Runtime ${short(event.sessionId)}（媒体播放中没人说话）`;
    case "runtime.reopened":
      return `重开 Runtime ${short(event.sessionId)}（释放后被打断，回到听）`;
    case "usage":
      return `用量     ${JSON.stringify(event.usage)}`;
    case "error":
      return `出错     ${event.deviceId} ${event.error.message}`;
  }
}
