# 参与贡献

改动保持小，并且能用现有测试说清楚。设计上的取舍见 [docs/01-principles_zh.md](docs/01-principles_zh.md)。

## 环境

[Bun](https://bun.sh) 1.4.x（与 CI 相同）。

```bash
git clone https://github.com/nangongbee/VoxEngine.git
cd VoxEngine
bun install
bun test
bun run check
```

`bun test` 不访问外网。`bun run check` 是 `tsc --noEmit`。

## 改什么、放哪

- 新行为优先加测试：核心和适配器用假终端，不要为了测而连真实厂商。
- 厂商协议的细节留在 `packages/providers`；设备协议的细节留在 `packages/adapters`。核心只认 `packages/protocol` 里的消息。
- 人设、曲库、提示词、密钥放在你自己的产品里，不要放进本仓库。
- 不要提交 `.env`、音频故事、日志。`examples/*/.env.example` 只保留空变量名。

## Pull Request

1. 从最新 `master` 拉分支。
2. 提交前本地跑过 `bun test` 和 `bun run check`。
3. 说明为什么改，而不只是改了哪几行。
4. 推送后 GitHub Actions 会再跑同样两条命令。红了先在本地复现。

## 安全问题

不要开公开 Issue 贴密钥、设备地址或可利用的细节。用 GitHub 仓库的 Security 页私下报告；若页面还不可用，直接联系仓库所有者。
