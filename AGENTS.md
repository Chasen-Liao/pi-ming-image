# pi-ming-image

Pi 扩展：通过 OpenRouter 调用 Ming 图像模型（`design` 文生图 / `layer` 单图拆层），
同时暴露 `/ming-image` 斜杠命令和 `generate_ming_image` Agent 工具。**无运行时依赖**——
只用 Node 标准库，依赖通过 `peerDependencies` 由 Pi 在加载时提供。

## 怎么跑

```bash
npm test                                    # 86 个测试，不需要网络
npx tsc --noEmit --strict --skipLibCheck \
  --target es2023 --lib es2023,dom --module nodenext \
  --moduleResolution nodenext --allowImportingTsExtensions \
  extensions/index.ts lib/*.ts test/*.ts    # 类型检查
```

`test/extension.test.ts` 直接 import 扩展模块，所以 `node_modules/@earendil-works/pi-coding-agent`
和 `node_modules/typebox` 必须能解析（见 README「Test dependencies」的 junction 做法）。
其余测试不依赖它们。

`test/run-ming-command.ps1` 是手动联调脚本，会发**真实付费请求**，不在 `npm test` 内。

## 结构与约定

- `lib/generate.ts` 是唯一实现路径，命令和工具都调它；不要在扩展层另写一条。
- `lib/errors.ts` 的错误码是命令与工具共同的用户可见契约，消息里不得出现
  凭证、base64 或上游原始响应体。
- 失败或取消必须删掉输出目录，不允许留下半成品并报告成功。
- 生成物写**调用方** cwd 下的 `artifacts/`，绝不写回包目录。
- 新增图像相关逻辑优先用标准库；引入运行时依赖需要先说明为什么绕不过去。

## 当前状态

v0.1.1 已发布（npm + GitHub tag），真实 design/layer 均已实测。

2026-09-29 修了一次「生图后会话卡住」：实际卡的不是生图调用本身，而是之后那次模型请求——
`read` 会把整张全分辨率 PNG 以 base64 永久塞进上下文（单次 1.1–1.5MB）。三项修复：
进度反馈（`onUpdate` + 10s 心跳）、`previews/` 缩略图（`lib/png.ts` 纯 zlib 实现）、
声明体积超限时释放响应体。

**仍未解决**：openai-codex 的 `fetch failed`（407 个会话里 32 次有 30 次上下文无图）
是既有的网络问题，与本包无关；上下文图片 ≥1MB 时该 provider 失败率升高（1.4%→5.8%）
只做到相关性定位，没有因果证明。

## 下一步

预览只支持 PNG（无 JPEG/WebP 解码器）。若要覆盖，需要引入解码依赖——先权衡再定。
