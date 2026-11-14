# 工具调用

已实现：`packages/core/src/tool.ts`、`session.ts`；测试 `tests/tools.test.ts`；示例 `examples/05-custom-skill`。

按「框架给机制，产品定策略」（见 `01-principles_zh.md` 第 2 节第 8 条）拆分。

---

## 1. 现状

- 工具可以只回文字，也可以回「文字 + 一段要播的音频」（`ToolOutput`）。
- 来源：`Profile.tools` 加上设备 MCP 列出的工具（经 `deviceTools` 筛选后）合并进会话。
- 每次调用发 `tool.called` / `tool.returned`；媒体另有 `media.started` / `media.progress` / `media.ended`。
- 级联 Runtime 按顺序执行工具；实时 Runtime 并行执行、一起提交（失败也提交）。
- 超时、取消、音频排队都在核心处理；Runtime 看到的仍是「只回文字」的 `RuntimeTool`。

---

## 2. 分工

| 框架（核心） | 产品 |
|--------------|------|
| 工具结果可以带一段音频，核心排在回复后面播 | 播什么、文件在哪、怎么挑、怎么转码 |
| 打断、会话结束、超时时通知工具取消 | 收到取消后怎么收尾 |
| 每个工具有超时，有默认值 | 每个工具设几秒 |
| 留一个口子筛选、改写设备工具 | 开放哪几个、描述怎么改 |
| 音频能不能被说话打断、播完回到听还是结束：给开关 | 开关怎么选 |
| 调用、返回、超时、取消、媒体开始结束都发事件 | 记日志、统计 |
| — | 参数容错（比如 `"True"`），工具自己处理 |
| — | 调工具时的等待语（见第 7 节） |

---

## 3. 接口（与代码一致）

### 3.1 Tool（`packages/core/src/tool.ts`）

```ts
export interface Tool extends ToolSpec {
  /** 超时，默认用 Profile.toolTimeoutMs。 */
  timeoutMs?: number;
  /** 返回给模型的文字，或文字加一段要播的音频。失败就抛错，错误信息会回给模型。 */
  invoke(args: unknown, ctx: ToolContext): Promise<string | ToolOutput>;
}

export interface ToolContext {
  sessionId: string;
  deviceId: string;
  /** 下行格式。要播的音频必须是这个格式。 */
  output: AudioFormat;
  /** 用户打断、会话结束、超时时触发；reason 是 "interrupted" | "ended" | "timeout"。 */
  signal: AbortSignal;
}

export interface ToolOutput {
  content: string;
  media?: Media;
}

export interface Media {
  title?: string;
  frames: AsyncIterable<AudioFrame>;
  /** 播放时用户说话能不能打断。默认跟 Profile.bargeIn。按键、唤醒词总能打断。 */
  bargeIn?: boolean;
  /** 播完以后：回到听（默认），或者结束会话。 */
  after?: "listen" | "end";
}
```

### 3.2 Runtime 看到的工具（`packages/core/src/runtime.ts`）

```ts
/** 核心包过一层：只回文字；超时、取消、音频已在核心处理。 */
export interface RuntimeTool extends ToolSpec {
  invoke(args: unknown): Promise<string>;
}
```

### 3.3 Profile 相关字段（`packages/core/src/profile.ts`）

```ts
toolTimeoutMs?: number;                 // 默认 10 秒
deviceTools?(tools: ToolSpec[]): ToolSpec[];
media?: {
  waitMs?: number;            // 等确认语多久；默认 4 秒
  releaseRuntimeMs?: number;  // 播放中多久没人说话关 Runtime；0 不关，默认 0
};
```

### 3.4 相关事件

`tool.called`、`tool.returned`（可带 `failure: error | timeout | cancelled`）、`media.started`、`media.progress`、`media.ended`、`runtime.released`、`runtime.reopened`。

下行已有 `play.start kind: "media"`。

---

## 4. 媒体怎么播

1. 工具返回 `{ content, media }`。核心把 `content` 交给 Runtime，把 `media` 放进待播队列。
2. 回复播完（或 `reply.done` 且没有回复音频）时开播媒体：`play.start kind: "media"`，状态仍是 `speaking`。
   - **开播兜底**：还没有回复在播时，最多等 `media.waitMs`；模型一直不开口也直接播，之后迟到的回复音频丢掉。
   - 实时模式下工具结果交回后厂商才说确认语，可能被当成新一轮；待播队列不随新一轮清空，只在打断时清空。
3. 播放期间不计空闲；按键、唤醒词总能打断；说话能否打断看 `media.bargeIn`。
4. 播完：`after: "listen"` 回到听；`"end"` 结束会话（`reason: done`）。
5. 回复还没播完就被打断：本轮待播媒体全部丢掉，迭代器 `return()`。
6. 一轮多个带媒体的工具：按返回顺序依次播。
7. 帧格式和 `ctx.output` 不一致：`media.ended reason: "error"`，回到听。
8. **长播放释放 Runtime**：`releaseRuntimeMs > 0` 且播放中这么久没人说话 → 关 Runtime、发 `runtime.released`；媒体照播，播完结束会话。期间被唤醒/按键/文字打断 → 停媒体、重开 Runtime（`runtime.reopened`）、回到听（上下文不带过去）。级联一般设 0；实时长连接才有意义。
9. 已知风险：实时 + 允许说话打断时，服务端 VAD 可能把喇叭内容当作用户；回声大时把 `media.bargeIn` 设为 false。

---

## 5. 超时和取消

- 每次调用核心建 `AbortController`，工具拿到 `signal`。
- 用户打断：取消本轮未返回的工具；会话结束：全取消；超时：只取消这一个。
- 取消/超时后核心不再等工具，给 Runtime 错误文案；实时 Runtime 仍会提交，避免服务端挂住。
- 晚到的结果丢掉。设备工具的 pending 也听同一个 `signal`。

---

## 6. 筛选设备工具

- `Profile.deviceTools(tools)` 在开会话时调用，返回值交给模型。
- 可白名单、可改描述；只管设备工具。`Profile.tools` 是产品自己给的，不再筛。

---

## 7. 先不做

- **调工具时的等待语。** 级联通常模型会先说一句；实时要么厂商私有接口，要么预先合成的提示音。有慢工具后再在 `ToolContext` 上加播提示音的方法。
- **主动播报**（提醒、推送）。与媒体同路径，产品需要时再给入口。
- **远程 MCP。** 做成把远程工具变成 `Tool` 的小函数即可；技能不是框架概念。
- **参数校验库。** 工具自己处理。

---

## 8. 例子

`examples/05-custom-skill/`：从目录挑 Ogg Opus（须与设备下行格式一致），返回确认语 + 音频。只证明口子；转码、缓存、曲库归产品。
