# VoxEngine

[English](README.en.md)

可自己部署的语音终端引擎（TypeScript）。各种语音终端连到同一个网关，用同一套会话引擎对话；说话方式（级联 / 实时）和模型厂商都能换。

当前硬件入口兼容[小智固件](https://github.com/78/xiaozhi-esp32)的 WebSocket 协议（`/chat`）；服务端自建，不改固件。本仓库与小智、火山引擎没有隶属关系，见文末归属声明。

## 环境

- [Bun](https://bun.sh)（示例与测试按 Bun 写，开发用 1.4.x 验证）
- 真机示例需要能连上本机的小智兼容设备，以及对应云厂商密钥（见下）

```bash
git clone https://github.com/nangongbee/VoxEngine.git
cd VoxEngine
bun install
bun test
bun run check
```

## 最快跑通（无需硬件、无需密钥）

```bash
bun examples/01-fake-terminal/index.ts
```

假终端说一句话，回声 Runtime 播回来，并演示一次打断。

## 接小智设备

1. 电脑与设备同一局域网；防火墙放行端口（默认 `18989`）。
2. 设备 WebSocket 指到：`ws://<电脑局域网IP>:18989/chat`。
3. 按需求选下面某一档示例。

> **只在自己信任的内网里跑这些示例。** 示例把网关绑在 `0.0.0.0`，`/chat` 只读 `Device-Id` 头认设备，没有鉴权，也没有 TLS。端口一旦能从公网访问，任何人都能连上来对话，用掉你的厂商额度。公网部署请自己加鉴权和 TLS（例如放到反向代理后面、校验设备凭据），并只开放必要端口。

### 回声（验证链路，不要密钥）

```bash
bun examples/02-xiaozhi-echo/index.ts
```

设备说话后原样回放。

### 级联对话（识别 → 大模型 → 合成）

```bash
cp examples/03-xiaozhi-cascade/.env.example examples/03-xiaozhi-cascade/.env
# 编辑 .env：至少填 DOUBAO_API_KEY（或 APP_ID+ACCESS_KEY）和 ARK_API_KEY、ARK_MODEL
set -a && source examples/03-xiaozhi-cascade/.env && set +a
bun examples/03-xiaozhi-cascade/probe.ts   # 可选：合成 → 识别 → 大模型自检
bun examples/03-xiaozhi-cascade/index.ts
```

### 端到端实时语音

```bash
cp examples/04-xiaozhi-realtime/.env.example examples/04-xiaozhi-realtime/.env
# 编辑 .env：填 DOUBAO_API_KEY（实时只认新控制台 API Key）
set -a && source examples/04-xiaozhi-realtime/.env && set +a
bun examples/04-xiaozhi-realtime/probe.ts  # 可选自检
bun examples/04-xiaozhi-realtime/index.ts
```

与示例 3 同一台设备，主要差别是 Runtime 一行。

### 讲故事工具（媒体播放）

在示例 3 或 4 的密钥基础上：

```bash
mkdir -p examples/05-custom-skill/stories
# 放入 24 kHz 单声道 Ogg Opus、约 20 ms 一帧，例如：
# ffmpeg -i 故事.mp3 -ac 1 -ar 24000 -c:a libopus -b:a 48k -frame_duration 20 -application audio \
#   examples/05-custom-skill/stories/小兔子.ogg
set -a && source examples/04-xiaozhi-realtime/.env && set +a   # 或 cascade 的 .env
bun examples/05-custom-skill/index.ts                          # 默认实时
RUNTIME=cascade bun examples/05-custom-skill/index.ts          # 级联
```

对设备说要听故事，模型应调用 `play_story`；确认语后开始播文件。

## 目录

```text
packages/
  protocol/   终端 ↔ 核心的内部协议、音频帧、事件类型（零依赖）
  core/       会话、轮次、播放控速、打断、空闲结束、设备工具
  audio/      Ogg / Opus 拆包解码、PCM 工具
  providers/  厂商：识别、大模型、合成、VAD、实时；doubao、openai 兼容
  runtimes/   cascade / realtime / echo；各自声明能力
  adapters/   xiaozhi（小智 /chat）、fake
  gateway/    HTTP/WebSocket 服务、路由、事件日志
examples/     可运行的例子
tests/        跨包集成测试
docs/         设计文档
```

本仓库是 Bun workspaces；包名 `@voxengine/*`，目前按源码引用（`workspace:*`），适合直接从 Git 使用。根 `package.json` 标了 `private`，避免误发 npm。

## 文档

1. [docs/01-principles_zh.md](docs/01-principles_zh.md)：规则、分层与目录、路线图、参考库
2. [docs/03-internal-protocol_zh.md](docs/03-internal-protocol_zh.md)：适配器 ↔ 核心消息、音频、打断、主动播报
3. [docs/05-tool-calling_zh.md](docs/05-tool-calling_zh.md)：工具与媒体：框架 / 产品分工、超时、取消

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。推送和 Pull Request 会跑 GitHub Actions：`bun install`、`bun test`、`bun run check`。

## 归属

- 设备侧协议兼容 [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32)（MIT）。本仓库只实现服务端，不包含、也不修改该固件。
- `doubao`、`openai` 目录是对火山引擎语音 / 方舟，以及 OpenAI Chat Completions 兼容接口的客户端。接口、商标归各自所有者。
- 唯一的第三方运行时依赖是 [opusscript](https://github.com/abalabahaha/opusscript)（MIT），用于 Opus 解码。

VoxEngine 与上述项目和厂商没有隶属、背书或合作关系。

## 许可证

MIT
