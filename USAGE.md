# DSH CTF 工作区使用说明

做手动选卡对照时，在 `inspect-header` 的 `execute` 请求顶层传入 `include_method_card: false`。工具仍会返回文件头检查结果，再用 `retrieve` 单独检索。省略该字段时自动选卡照常启用。

Misc 附件已放入受信的 `fixtures/misc` 目录时，可在 `start` 后用一次 `execute` 调用 `static-local` 的 `inspect-header`。例如传入 `{"file":"phase2b.zip"}`，响应同时提供大小、格式、SHA-256 和匹配的方法卡。支持 ZIP、PNG、RIFF WAVE 和规范 Base64（`.b64`）的初步识别。文件签名只用于选择方法卡，内容完整性需进一步检查。

Reverse 和 Pwn 任务的 `inspect-header` 识别到 ELF 签名时，会按任务类别附上对应的静态方法卡。Crypto 和 Web 可从 `src/index.js` 调用纯离线的 `selectOfflineMethodCard`。Crypto 传入 `category: 'crypto'`、`algorithm: 'XOR'`、十六进制 `ciphertext` 和单字节整数 `key`。Web 传入 `category: 'web'`，以及含 HTTP 起始行的 `httpRecord` 或导入 Node HTTP 模块的 `source`。不匹配的输入返回 `NO_RESULT`。

本地 Misc Base64 样本流程已通过 DSH 桌面真实验收。

1. 在 DSH 桌面打开 `DSH-CTF-Workspace`，新建会话。验收使用的模型为 `aliyun / deepseek-v4.1-flash`。
2. 让 Agent 调用 `ctf_workspace` 的 `start`，任务分类设为 `misc`。Gateway 进行授权和预检，Agent 使用返回的 Misc Skill。
3. 调用 `ctf_workspace` 的 `execute`，工具 ID 设为 `misc-local`，子操作设为 `base64-decode`，文件参数传 `{"file":"sample.b64"}`。文件名相对于 `fixtures/misc`，省略目录前缀。
4. Gateway 授权后，Executor 执行 Base64 解码并将结果返回 Agent。用成功执行的 `operation_id` 和解码结果调用 `verify`。`LOCALLY_VERIFIED` 表示结果通过独立预期值验证。

本次桌面任务状态为 `COMPLETED`，用时 10 秒，DSH 估算费用为 ¥0.05196545。供应商实际扣费尚未独立确认。[成功任务审计](data/ctf-23e90ff2-f2df-4a78-b285-639a9cd69f49/evidence.jsonl)

本次知识库检索返回 `NO_RESULT`，依赖知识库命中的流程尚未完成验收。Web、Crypto、Reverse 和 Pwn 的真实桌面端到端能力尚未验收。

2026-11-14 核对 DSH 历史会话时，HelloPHP 使用了普通工具。EasyStack 的附件不在受信 fixture 目录内，`static-local` 拒绝后会话通过普通工具继续。两份回答都未取得 `LOCALLY_VERIFIED` 回执。Gateway 的授权只约束自身工具，普通 DSH 工具还需由宿主显式施加限制。附件登记不会扩大 fixture 范围。

2026-11-14 扩展复核覆盖此工作区登记的全部 19 个历史会话（包含重复题目和样本验收）。当前 Gateway 是受限原型：桌面许可为 90 秒、最多 6 次执行，Crypto 仅提供 XOR，压缩包工具仅列出固定样本，外部 Web 与动态调试未开放。普通工具解出的题目不代表 Gateway 已具备相应能力。`LOCALLY_VERIFIED` 也不等于竞赛平台接受答案；其他前缀、语义推断和平台反馈需另行核对。

本次修复增加过期后的证据摘要查询、有效 JSON 模型反馈、长输出截断标识和损坏历史隔离。原有桌面验收记录不能替代这些修改在运行中 DSH 插件的重新加载与验收。
