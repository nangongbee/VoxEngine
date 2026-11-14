# 工具调用

状态：已实现（`packages/core/src/tool.ts`、`session.ts`），测试在 `tests/tools.test.ts`，示例在 `examples/05-custom-skill`。第 1 节是实现前的样子。

按「框架给机制，产品定策略」（见 `01-principles_zh.md` 第 2 节第 8 条）拆分。

---

## 1. 现在的样子

- `Tool = ToolSpec + invoke(args) → Promise<string>`，只能回文字。
- 工具来源：`Profile.tools` 加上设备 MCP 列出的工具，在 `Terminal` 里合并。
- `Session.observe` 给每个工具包一层，发 `tool.called` / `tool.returned`。
- 级联 Runtime 按顺序执行；实时 Runtime 并行执行、一起提交、失败也提交。
- 设备工具有超时（`toolTimeoutMs`），服务端工具没有；都不能取消。

缺的：工具不能让设备播音频；工具不知道用户打断了；服务端工具可能一直挂着；设备工具全部交给模型，产品没法挑。

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

Runtime 不变：它看到的工具仍然只回文字。音频、取消、超时都在核心那一层处理。

---

## 3. 接口草案

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
  /** 给模型看的文字。 */
  content: string;
  media?: Media;
}

export interface Media {
  /** 给日志和事件看的名字。 */
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
/** 核心包过一层的工具：只回文字；超时、取消、音频都已经在核心处理掉。 */
export interface RuntimeTool extends ToolSpec {
  invoke(args: unknown): Promise<string>;
}
```

`RuntimeContext.tools` 从 `Tool[]` 改成 `RuntimeTool[]`。级联、实时 Runtime 代码不用改，只改类型名。

### 3.3 Profile（`packages/core/src/profile.ts`）

```ts
export interface Profile {
  // ……已有字段
  /** 工具默认超时。默认 10 秒。 */
  toolTimeoutMs?: number;
  /** 设备列出的工具怎么交给模型：可以删、可以改描述。默认全部交出。 */
  deviceTools?(tools: ToolSpec[]): ToolSpec[];
  media?: {
    /** 工具返回音频后，最多等模型的确认语多久；还没开口就直接播。默认 4 秒。 */
    waitMs?: number;
    /** 媒体播放中多久没人说话就关掉 Runtime。0 表示不关。默认 0。 */
    releaseRuntimeMs?: number;
  };
}
```

`EngineOptions.toolTimeoutMs` 去掉，超时统一走 Profile。

### 3.4 事件（`packages/protocol/src/events.ts`）

```ts
| { type: "tool.returned"; sessionId; callId; ok: boolean; content: string; ms: number;
    /** 失败原因。 */
    failure?: "error" | "timeout" | "cancelled" }
| { type: "media.started"; sessionId; turnId; title?: string }
| { type: "media.ended"; sessionId; turnId; title?: string; playedMs: number;
    reason: "done" | "interrupted" | "error" }
| { type: "runtime.released"; sessionId }
```

下行协议不变：已经有 `play.start kind: "media"`。

---

## 4. 媒体怎么播

1. 工具返回 `{ content, media }`。核心把 `content` 交给 Runtime，把 `media` 放进待播队列。
2. 回复播完（或者没有回复音频，Runtime 发了 `reply.done`）时，开始播媒体：下发 `play.start kind: "media"`，状态仍是 `speaking`。
   - **开播兜底**：媒体入队时还没有回复在播，就最多等 `media.waitMs`；模型一直不开口（实时厂商没回、回复没有音频）也直接播。之后迟到的回复音频丢掉。
   - 实时模式下，工具结果交回后厂商才说确认语，可能被 Runtime 当成新的一轮；队列不随新一轮清空，只在打断时清空。
3. 播放期间：
   - 不计空闲时间。
   - 按键、唤醒词总能打断。
   - 用户说话能不能打断看 `media.bargeIn`；不能时，上行音频照现在的规则丢掉。
   - 打断媒体时，如果 Runtime 的回复已经结束，不再调 `runtime.interrupt`。
4. 播完：`after: "listen"` 回到听；`"end"` 结束会话，原因是新加的 `done`（`SessionEndReason` 增加这一项），和没人说话的 `idle` 分开。
5. 回复还没播完用户就打断了：这一轮的待播媒体全部丢掉，`frames` 迭代器调 `return()` 关闭。
6. 一轮里多个工具都带媒体：按工具返回的顺序依次播。
7. 帧格式和 `ctx.output` 不一致：报错，发 `media.ended reason: "error"`，回到听。
8. **长播放释放 Runtime**：`media.releaseRuntimeMs` 大于 0 时，媒体播放中这么久没人说话，核心关掉 Runtime（省钱，也避免厂商长连接闲置超时），发 `runtime.released`。之后上行音频丢掉、说话不再打断；媒体照播，播完结束会话（`done`）。期间被唤醒词、按键或文字打断，说明用户要说话：核心停掉媒体，重开一个 Runtime（发 `runtime.reopened`），回到听；之前的对话上下文不带过去。释放只对按时长计费的长连接（端到端实时）有意义，级联一般设 0。
9. 已知风险：实时模式下允许说话打断媒体时，厂商的服务端 VAD 可能把喇叭里的故事当成用户说话。要真机验证；回声大的设备把 `media.bargeIn` 设为 false，靠按键打断。

---

## 5. 超时和取消

- 每次调用核心建一个 `AbortController`，传给工具的是它的 `signal`。
- 三种触发：
  - 用户打断：取消本轮所有还没返回的工具；
  - 会话结束：取消所有；
  - 超时：只取消这一个。
- 取消或超时后，核心不再等工具，直接给 Runtime 一个错误（「工具超时」「已取消」）。实时 Runtime 照样提交结果，不会让服务端挂住。
- 工具自己晚到的结果丢掉。
- 设备工具：`Terminal` 里那套 pending 改成听 `signal`。超时统一由核心管，`TerminalDeps.toolTimeoutMs` 去掉。

---

## 6. 筛选设备工具

- `Profile.deviceTools(tools)` 在每次开会话时调用，返回值就是交给模型的设备工具。
- 产品可以只留白名单里的工具，也可以改描述（比如删掉提到未开放工具的句子）。
- 只管设备工具；`Profile.tools` 本来就是产品自己给的，不需要再筛。

---

## 7. 先不做

- **调工具时的等待语。** 真问题，但现在慢工具少。级联模式下模型通常会先说一句；实时模式下要么用厂商私有接口，要么播预先合成的提示音，做法因厂商而异。等有了慢工具，在 `ToolContext` 上加一个播提示音的方法。
- **主动播报**（提醒、推送）。和媒体走同一条播放路径，等产品需要时给 `Terminal` 加一个入口。
- **远程 MCP。** 不在本次范围；之后做成 `packages/tools` 里的一个小函数，把远程服务器的工具变成 `Tool`。技能不是框架概念，产品自己拼 Profile。
- **参数校验。** 不引 JSON Schema 校验库，工具自己处理。

---

## 8. 例子

`examples/05-custom-skill/`：`story.ts` 从目录里挑一个 Ogg Opus 文件（格式需与设备下行一致），返回「网关会直接播放《xx》」加音频。只证明口子能用，不做曲库；转码、缓存、文本故事合成归产品。
