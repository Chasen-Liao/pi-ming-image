# Pi Ming Image：独立插件执行计划

状态：历史执行计划（制定于 2026-09-28）。下文“无提交”“私有占位仓库”“尚未验证”均是制定时的背景，不代表当前发布状态；当前安装、实测结果与限制以 `README.md` 为准。

## 目标与仓库边界

- 本目录是唯一源码目录；做成可由 Pi 本地安装的 package，同时提供 `/ming-image` 命令与 `generate_ming_image` Agent 工具。
- 两项能力：`inclusionai/ming-image-0.1-design` 文生图；`inclusionai/ming-image-0.1-design-layer` 单张本地图片拆层。调用 OpenRouter `POST /api/v1/images`，**不**把图像模型注册为聊天模型。
- 测试场地是 `D:\MyProjects\ming-image-web-lab`，通过本地路径加载本包；不要复制扩展源码到该工作区的 `.pi/extensions/`。生成物默认写入 Pi 当前工作目录的 `artifacts/`，不写入包仓库。
- 本目录已是本地 Git 仓库，`origin` 是私有占位仓库 `https://github.com/Chasen-Liao/pi-ming-image`；目前无提交。开发、提交、推送、公开发布是不同动作：未经新的明确授权，不提交、推送或改成公开仓库。

## 已有证据与未知项

- 实验工作区的 `scripts/ming-image.ps1` 已通过 `/api/v1/images` 完成一次 Design 调用：2026-09-28 生成 `artifacts/design-20260928-162336/design_01.png`，约 59 秒，返回 `usage.cost = 0`。可参考 `manifest.json`，但这**不是插件通过的证据**。
- OpenRouter 聊天接口曾对 Design 模型返回 404，提示改用图像接口。此前 handoff 中 SDK 图像调用走聊天接口的建议不适用。
- 尚未真实验证 Layer 的图片、张数、质量和费用，也未验证插件的两个入口及本地包加载。先检查项目内现有脚本和 Pi 版本/API，不假设旧文档或模型返回行为仍成立。

## 任务顺序

### 1. 包骨架与契约

- 核对本机 Pi `docs/extensions.md`、`docs/packages.md` 及相关 API 类型；选择本仓库的 `extensions/`、`lib/`、`test/` 组织源码，`package.json` 显式声明扩展入口与实际依赖。先不增加不必要的技能或 UI。
- 定义手动命令：`/ming-image design <UTF-8提示词文件>` 与 `/ming-image layer <UTF-8提示词文件> <图片路径>`；支持引号包裹含空格路径，错误输入不发请求。
- 定义工具 `generate_ming_image`：`task: design | layer`、`prompt: string`、仅 Layer 必需的 `imagePath: string`。工具直接收文字，无须写临时提示词文件。工具说明须明确 Layer 会把所指本地图片上传到 OpenRouter；本计划不构成上传任何具体图片的授权。

### 2. 单一请求与落盘实现

- 命令与工具共用一条实现路径。运行时从 Pi 的 OpenRouter provider 凭证或进程环境变量获取 token；先确认 `ctx.modelRegistry.getApiKeyForProvider('openrouter')` 对当前 OAuth 适用。绝不读取、输出、提交或记录明文 token。
- 请求形状参照实验脚本：Design 只有文字；Layer 只有文字和一张 PNG/JPEG/WebP 图片；不传 size/aspect_ratio。加入可取消的请求与足够长的超时，不做可能导致意外费用的无界重试。
- 校验输入体积、响应数量/大小、MIME 与文件魔数。以唯一目录保存实际图片和 `manifest.json`（任务、模型、输入记录、实际文件、用时、返回的 usage、时间）；禁止把 token、图片 base64 或原始敏感错误体写入产物/日志。失败和取消不报告成功，清理不完整产物。
- 返回实际文件路径和数量；不要把生成图片 base64 放入 Agent 上下文。显式区分 402、429、空图片、错误格式、取消与文件写入错误。

### 3. 可重复测试（先模拟，再实测）

- 模拟 HTTP 和凭证，覆盖两任务请求结构、命令参数解析、工具参数校验、输出目录并发冲突、manifest 脱敏、错误码/坏图/中断与失败清理；用项目内适配的轻量测试命令运行。
- 从实验工作区使用本地路径安装/配置 package（项目 `.pi/settings.json` 的相对路径以该文件所在 `.pi/` 为基准），授予 Pi 项目信任后重启 Pi 或 `/reload`。验证命令与工具确实来自本仓库且只加载一次。
- 分别通过插件真实调用 Design 和 Layer；检查每张图片和 manifest、记录实际耗时/张数/费用。Layer 结果与提示要求未必一致；不把模拟测试或旧脚本的 Design 成功冒充 Layer/插件实测。真实调用前确认图片是允许上传的素材。
- 在另一个工作目录检查输出跟随 cwd，而非写回实验工作区或包目录；检查仓库改动不包含密钥和生成图片。

### 4. 本地完成与后续公开

- 验收：包可加载；两入口可见且共用实现；两任务通过插件真实落盘且记录与实际相符；异常路径无假成功或凭证泄露。若 Layer 调用失败，记录原因与证据，**不得声称全部完成**。
- 整理安装/卸载说明、环境与局限；实测文章等 Layer 的效果/数量/成本证据齐全后再写。公开仓库、许可证、提交与推送另行决定，不在本阶段自动执行。

## 下次工作时的第一步

从 `D:\MyProjects\pi-ming-image` 启动 Pi；先查看本目录状态与实验工作区的 `scripts/ming-image.ps1`、`prompts/layer-test.txt`、相关 Pi 文档，再按第 1 步实施。不要在实验工作区复制一份实现。
