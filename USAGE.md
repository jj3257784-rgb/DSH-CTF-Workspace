# DSH CTF 工作区使用说明

## 安装条件与启动

原生工作台需要 Git、Node.js 24 和 npm。内置样本可离线运行，外部程序需匹配工具清单中的路径和指纹。完整环境需要支持 Linux 容器的 Docker、Compose、空闲的本机 8080 端口，以及首次构建时的网络连接。

~~~sh
git clone https://github.com/jj3257784-rgb/DSH-CTF-Workspace.git
cd DSH-CTF-Workspace
~~~

原生运行用 npm start，完整工具环境用 docker compose up --build。打开终端打印的完整链接，保留 # 后面的访问凭据。原生端口自动分配，Docker 使用 8080。按 Ctrl+C 停止前台工作台。原生任务保存在 data 目录，容器任务保存在命名卷中。运行 npm test 执行全套离线测试；Docker 构建时自动运行同一套测试。

## 第一次解题：解码自带样本

1. 创建 Misc 任务，使用 local-only 范围，选择 misc-local。
2. 在“执行操作”选择 misc-local，操作 ID 填 sample，文件名填 sample.b64，点击“执行”。自带样本位于 fixtures/misc 中。
3. 展开“本次执行结果”，解码文本应为 flag{phase1b_misc}。在“候选 Flag 与本地验证”填入同一个操作 ID 和候选值，点击“核对格式与工具输出”。
4. 查看执行记录，点击“导出 JSON”保存结果。处理其他样本时，先确定题型、输入与授权范围，再选择工具，保存操作 ID，根据实际输出登记候选，最后核验。竞赛答案以平台提交结果为准。

## 运行其他模式

- Web 适配器仅接受明确授权的回环 HTTP 来源。Docker 中的 127.0.0.1 指向容器自身；要使用宿主机回环测试服务，可在宿主机原生启动。
- 在线 Solver 需要 CTF_MODEL_NAME 和 CTF_MODEL_BASE_URL，远程 HTTPS 地址还需 CTF_MODEL_API_KEY。桌面插件需要兼容的 DSH 宿主。
- 原生工具提示未安装或指纹不匹配时，可使用完整容器环境。Docker 引擎须先成功启动。

## 桌面插件与方法卡

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
