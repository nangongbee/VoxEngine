# 内部协议：适配器 ↔ 核心

定消息种类、字段、时序。类型定义在 `packages/protocol/src`，两边不一致时以代码为准。

---

## 1. 先说清楚它是什么

- **进程内合同，不是线上协议。** 适配器和核心在同一个进程，消息是带类型的对象，不序列化。只有假终端录制、回放测试时才落成 JSON。
- **终端只认这一套。** 小智的 JSON + Opus、网页麦的格式，全部在适配器里翻译掉，核心里不出现 `if 小智`。
- **和事件流分开。** 本协议给终端用；核心另有一条事件流给观察者（存档、计费、日志），见第 9 节。两者放在 `protocol` 包里，但不混用。

---

## 2. 四个 id

| id | 谁生成 | 寿命 | 说明 |
|----|--------|------|------|
| `deviceId` | 适配器（取自设备，如 MAC / Device-Id 头） | 永久 | 认设备、找记忆、主动播报都靠它 |
| `terminalId` | 核心 | 设备在线期间 | 一台设备在线时只有一个逻辑终端 |
| `sessionId` | 核心 | 一场对话 | 一个终端上同时最多一场 |
| `turnId` | 核心 | 一轮 | 用户一句 + 助手一段 |

**终端是逻辑的。** 小智同一台设备会开 `/chat`、`/push` 两条 WebSocket，适配器按 `deviceId` 合成一个终端交给核心。底下几条连接、什么时候重连，核心不管。

**连接在线 ≠ 在对话。** 终端 ready 后可以长时间没有会话；会话结束不关终端。

---

## 3. 能力协商

终端连上先发 `terminal.hello`，核心回 `terminal.ready`。之后才收别的消息。

`terminal.hello` 带 `deviceId` 和 `capabilities`：

| `capabilities` 字段 | 意思 |
|------|------|
| `audioIn` | 上行格式：`codec`（`opus` / `pcm16`）、`sampleRate`、`channels`、`frameMs` |
| `audioOut` | 设备能播的格式，按偏好排序，核心选第一个 |
| `vad` | 设备自己会不会报说话开始/结束 |
| `wakeOnly` | 支不支持「只听唤醒词」（`listen.set wake_only`） |
| `tools` | 设备能不能被调工具（小智 MCP），会不会发 `tool.list` |

`terminal.ready` 带：`terminalId`、选定的 `audioOut` 一种。

能力只在 hello 时定一次。设备能力变了就重新 hello。

---

## 4. 音频

**一个音频帧**：`codec`、`sampleRate`、`channels`、`frameMs`、`seq`（单调递增）、`data`。

规则：

1. 同一终端同一方向，格式在协商后固定，帧上的字段只是冗余校验。
2. **核心不转码。** 核心把终端选定的下行格式交给 Runtime，Runtime 按它出音频；实时链路两边都是 Opus 就直通。工具返回的媒体格式和下行格式不一致时，这段媒体以 `error` 结束，不播。需要转换时再在 `audio` 包里加，由 Runtime 或产品调用。
3. **下行由核心控速。** 核心的播放队列按墙钟一包包发（5ms tick，按 `frameMs` 占槽），与旧网关一致，不按超前量加速。冲太多会塞爆设备解码队列，听感像跳秒。「播到哪」按已发帧数 × `frameMs` 估算。设备不用回报播放进度。

---

## 5. 消息表

### 上行：终端 → 核心

| 消息 | 何时 | 字段 |
|------|------|------|
| `terminal.hello` | 连上 | 见第 3 节 |
| `tool.list` | 设备工具发现完 | 工具名、描述、参数 schema（已归一化） |
| `session.start` | 唤醒、按键、设备发文本 | `trigger`：`wake` / `button` / `text`；`wakeWord`；`listenMode`：`auto` / `manual` / `realtime` |
| `audio.in` | 持续 | 音频帧 |
| `speech.start` / `speech.end` | 设备自带 VAD 时 | 无 |
| `user.text` | 设备直接给文字 | `text` |
| `user.interrupt` | 按键打断、唤醒词打断 | `reason` |
| `tool.result` | 回应 `tool.call` | `callId`、`ok`、`content` |
| `session.end` | 设备主动结束 | `reason` |
| `terminal.bye` | 设备离线 | `reason` |

### 下行：核心 → 终端

| 消息 | 何时 | 字段 |
|------|------|------|
| `terminal.ready` | 回 hello | 见第 3 节 |
| `session.started` | 会话建立 | `sessionId` |
| `listen.set` | 控麦 | `open`（上行）/ `closed`（不收）/ `wake_only`（只听唤醒词） |
| `play.start` | 开始一段播放 | `turnId`、`kind`：`reply` / `announce` / `media` |
| `audio.out` | 播放中 | 音频帧 |
| `caption` | 有字可显示 | `role`：`user` / `assistant`；`text`；`final` |
| `play.stop` | 一段播放结束 | `turnId`、`reason`：`done` / `interrupted` |
| `tool.call` | 模型调设备工具 | `callId`、`name`、`args` |
| `session.ended` | 会话结束 | `reason`：`idle` / `done`（按设定播完就结束）/ `user` / `error` / `replaced` |

心跳、重连、二进制帧头、字库、OTA 都留在适配器里，不进本表。

---

## 6. 会话状态

```text
            session.start
   (无会话) ─────────────▶ listening ◀────────────────┐
                              │ 用户说完              │ play.stop(done)
                              ▼                       │
                           thinking ──首个音频──▶ speaking
                              │                       │
                              │        打断           │
                              └──────── listening ◀───┘
   任何状态 ── 空闲超时 / session.end / 出错 ──▶ ended
```

- 「用户说完」来自设备的 `speech.end`，或 Runtime 自己的 VAD（设备没有 VAD、或实时厂商的服务端 VAD）。核心只认结果，不管谁判的。
- 空闲超时、结束后是否转 `wake_only`，都是会话策略，从 Profile 来，核心不写死。

---

## 7. 打断

触发：`speaking` 状态下收到 `user.interrupt`，或 Runtime 报「用户开始说话」、Runtime 声明支持打断、且 Profile 没关插话。

「用户开始说话」是一个事件，判断标准由 Runtime 定、产品配：听到人声就算（打断快，回声大的设备会打断自己），或识别出字、过了 `Profile.acceptUtterance` 才算（慢半拍，回声识别出来多半是空的或碎片）。级联用 `startOn` 选，默认后者；钩子拿得到「此刻是否在播放」，过滤规则写在产品里。实时 Runtime 由厂商服务端判，不经过这个钩子。设备喇叭回声大时在 Profile 里关掉插话，按键打断不受影响。关掉插话后，播放期间的上行音频核心直接丢掉、不给 Runtime，免得回声被当成新的一句接在后面播。

核心按顺序做：

1. 清空播放队列，停止发 `audio.out`。
2. 发 `play.stop`，`reason: interrupted`。
3. 算出这一轮实际播出的时长和对应文字，通知 Runtime 取消生成，并按「只保留播过的部分」改写上下文。
4. 进 `listening`。

第 3 步的文字对齐由 Runtime 做（级联知道每句文本和时长；实时厂商给的是带时间的文本），核心只给时长。

---

## 8. 主动播报

还没实现，下面是设计。

产品调核心的 `announce(deviceId, 音频, 选项)`（网关负责暴露），不是终端发起的。

| 设备状态 | 核心怎么做 |
|----------|------------|
| 在线、无会话 | 开一场新会话（做的时候给 `session.start` 的触发方式加一种 `announce`），`listen.set closed`，播完按选项 `followUp` 决定转 `listening` 还是结束 |
| 在线、会话中 | 按优先级：`normal` 排到当前一轮之后；`urgent` 先打断再播 |
| 离线 | 不投递，返回「未送达」，由产品决定重试或换设备 |

**只收音频，下行用 `play.start kind: announce`。** 不收文本：实时厂商合成不了任意文本，交给 Runtime 合成会让两种 Runtime 行为不一致。要播文字，产品先用合成 Provider 转成音频。

---

## 9. 和事件流的关系

终端看到的只是上面的消息。观察者订阅核心的事件流，内容更细：

`session.started`（带 Runtime 名字和能力）、`turn.started`、`transcript`、`reply.text`、`interrupt`、`tool.called` / `tool.returned`、`latency`（用户说完 → 首个音频包）、`usage`、`session.ended`、`error`。

存档、计费、延迟统计全部挂在这里，不进协议。

`transcript` 带 `availability`：`live` 是这一轮当场识别的；`post_call` 是端到端语音厂商在会话结束后才补的。会话结束后核心仍接收 Runtime 的 `transcript` 和 `usage` 并转给观察者，但不再给终端下发字幕或音频，所以这类事件会排在 `session.ended` 后面。

---

## 10. 小智映射

适配器 `adapters/xiaozhi` 负责下表的翻译。带 *fork* 的是一些分支固件在上游之上加的扩展，适配器按 hello 判断有没有，没有就不用。

| 小智 | 内部 |
|------|------|
| `hello`（`audio_params`、`features.mcp`） | `terminal.hello`；回 hello ack 在收到 `terminal.ready` 之后 |
| MCP `tools/list` 结果 | `tool.list`（JSON-RPC 细节留在适配器） |
| `listen` `detect`（带唤醒词） | `session.start`，`trigger: wake` |
| `listen` `start`（`mode`） | 无会话时 `session.start`；有会话时只换模式 |
| `listen` `stop` | `speech.end`（manual 模式） |
| `listen` `vad_end` *fork* | `speech.end`（核心只在听的状态下认） |
| `listen` `vad_start` *fork* | 不转，原因见下 |
| `abort` | `user.interrupt` |
| `text` | `user.text` |
| 二进制音频（v1 / v2 / v3 帧头） | `audio.in` |
| — | |
| `play.start` | `tts` `start` |
| `caption` assistant | `tts` `sentence_start` + 文本 |
| `caption` user | `stt` |
| `play.stop` | `tts` `stop`（打断时带 `reason: interrupt`） |
| `listen.set wake_only` *fork* | `listen` `wake_only` |
| `tool.call` | MCP `tools/call` |
| `session.ended` | 关掉 `/chat` 连接（小智靠断连结束会话） |
| 主动播报 *fork* | `/push` 上的 `notify` |

`/record`、`/sync` 不是对话，属于产品功能：产品在网关上挂自己的路由，不经过本协议。分支固件开机后会每隔几秒请求 `/push`，网关没有这条路由时日志里会一直有 404，不影响对话。

对照固件 `main/protocols/websocket_protocol.cc`、`main/application.cc` 核实过的细节（实现在 `packages/adapters/src/xiaozhi`）：

- 帧头版本看升级请求的 `Protocol-Version` 头，默认 1（裸 Opus）。上下行用同一版本。
- 设备上行 Opus 16 kHz、60 ms 一帧。下行格式写在 hello ack 的 `audio_params` 里，设备按它建解码器。
- 实时聆听模式下固件会发 `vad_start` / `vad_end`，**播放时也发**（`application.cc` 的 `NoteVadSpeech`）。本地 VAD 会被自己的喇叭触发：BOX-3 实测把 `vad_start` 当插话，每段回复播到约 0.4 秒就被自己打断。所以 `vad_start` 不转，`vad: false`；插话由 Runtime 的 VAD（实时厂商的服务端 VAD、级联的 VAD）和设备按键判。`vad_end` 仍转成 `speech.end`，核心只在听的状态下认它，正在播放时收到会忽略。
- 设备不处理下行的 `abort`。打断用 `tts stop` + `reason: interrupt`，设备会清掉解码队列。
- hello 带 `purpose` 的连接不是对话（录音等），`/chat` 直接关掉。

---

## 11. 假终端

`adapters/fake` 吃一份脚本：hello 参数、按时间发哪些音频文件和消息；把收到的下行消息全部记下来。测试断言「消息顺序 + 关键字段」。

步骤 3 的验收：用假终端 + 假 Runtime（回声），跑通 hello → 会话 → 一轮 → 打断 → 空闲结束，不碰网络。

---

## 12. 暂不放进协议

- 表情 / 情绪、屏幕布局、灯效：先走 `caption`，有第二个终端需要时再加。
- 设备重启、OTA、系统指令。
- 一台设备同时多场会话。
- 终端之间转接对话。

---

## 13. 待定

1. 主动播报 `followUp` 默认开还是关。
2. 同一 `deviceId` 重复上线（旧连接没断干净）：新的顶掉旧的（`session.ended reason: replaced`），暂定如此。
