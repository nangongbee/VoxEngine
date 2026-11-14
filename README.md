# VoxEngine

可自己部署的语音终端引擎（TypeScript）。各种语音终端连到同一个网关，用同一套会话引擎对话；说话方式（级联 / 实时）和模型厂商都能换。

## 快速开始

```bash
bun install
bun examples/01-fake-terminal/index.ts   # 不用硬件、不用密钥跑通一场对话
bun examples/02-xiaozhi-echo/index.ts    # 小智设备连 ws://<本机>:18989/chat，说话后回放
bun examples/03-xiaozhi-cascade/probe.ts # 配好密钥后自检：合成 → 识别 → 大模型
bun examples/03-xiaozhi-cascade/index.ts # 小智设备真对话：豆包识别 + 方舟 + 豆包合成
bun examples/04-xiaozhi-realtime/probe.ts # 自检豆包端到端实时语音
bun examples/04-xiaozhi-realtime/index.ts # 同一台设备换成实时语音，和示例 3 只差 Runtime 一行
bun examples/05-custom-skill/index.ts    # 加一个讲故事工具：工具返回音频，核心接在确认语后面播
bun test
bun run check
```

## 目录

```text
packages/
  protocol/   终端 ↔ 核心的内部协议、音频帧、事件类型（零依赖）
  core/       会话、轮次、播放控速、打断、空闲结束、设备工具
  audio/      Ogg / Opus 拆包解码、PCM 工具
  providers/  厂商能力：识别、大模型、合成、VAD、实时语音；doubao、openai 兼容
  runtimes/   说话方式：cascade（级联）、realtime（端到端）、echo（回声，测试用）；各自声明能力
  adapters/   终端适配：xiaozhi（小智固件 /chat）、fake（假终端）
  gateway/    可运行的服务：HTTP/WebSocket、路由、事件日志
examples/     可运行的例子
tests/        跨包集成测试
docs/         设计文档
```

## 文档

1. [docs/01-principles_zh.md](docs/01-principles_zh.md)：开发规则、三层划分、路线图、参考的库
2. [docs/03-internal-protocol_zh.md](docs/03-internal-protocol_zh.md)：适配器和核心之间的消息、音频、打断、主动播报
3. [docs/05-tool-calling_zh.md](docs/05-tool-calling_zh.md)：工具调用：框架和产品怎么分、媒体、超时、取消

## 许可证

MIT
