# VoxEngine

[中文](README.md)

A self-hosted voice-terminal engine in TypeScript. Devices share one gateway and one session engine. You can swap how a session speaks (cascade: speech-to-text → LLM → speech synthesis, or a realtime voice model) and which vendor implements each step.

The hardware path speaks the [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) WebSocket protocol on `/chat`. If you are looking for a self-hosted xiaozhi server, this is a TypeScript one. It is not the official xiaozhi-esp32 server: this repository does not ship or modify device firmware, and it is not affiliated with that project or with Volcengine. See [Attribution](#attribution).

## Requirements

- [Bun](https://bun.sh). Examples and tests target Bun; development was verified on 1.4.x.
- A xiaozhi-compatible device on your LAN, plus vendor API keys, only if you run the hardware examples.

```bash
git clone https://github.com/nangongbee/VoxEngine.git
cd VoxEngine
bun install
bun test
bun run check
```

## Run without hardware or keys

```bash
bun examples/01-fake-terminal/index.ts
```

A fake terminal says a line, the echo runtime plays it back, and the script interrupts playback once.

## Hardware examples

Point the device at `ws://<your-LAN-IP>:18989/chat`. Steps for echo, cascade, realtime, and a story tool are in the [Chinese README](README.md).

> **Run the examples only on a network you trust.** They bind `0.0.0.0`. `/chat` accepts any client that sends a `Device-Id` header. There is no authentication and no TLS. If that port is reachable from the internet, anyone can talk to the gateway and spend your vendor quota. Put a reverse proxy with TLS and your own device check in front before exposing it.

## Layout

`packages/protocol` is the in-process contract. `core` runs the session, playback, and barge-in. `runtimes` is cascade, realtime, or echo. `providers` wraps vendors. `adapters` turns a xiaozhi socket or a fake terminal into that contract. `gateway` is the HTTP/WebSocket process. Product policy (persona, which tools, timeouts) stays outside this repository.

Packages are a Bun workspace (`@voxengine/*`, `workspace:*`). The root `package.json` is `private` so it is not published to npm by mistake. Use it from git.

## Docs

Chinese design notes: [principles](docs/01-principles_zh.md), [internal protocol](docs/03-internal-protocol_zh.md), [tool calling](docs/05-tool-calling_zh.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pushes and pull requests run `bun test` and `bun run check`.

## Attribution

- Device protocol compatibility: [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) (MIT). This repository implements a server for that protocol. It does not include or modify the firmware.
- The `doubao` and `openai` providers are clients for Volcengine speech / Ark and for OpenAI-compatible Chat Completions. Those APIs and trademarks belong to their owners.
- The only third-party runtime dependency is [opusscript](https://github.com/abalabahaha/opusscript) (MIT), used to decode Opus.

VoxEngine is not affiliated with, endorsed by, or a partner of those projects or vendors.

## License

MIT
