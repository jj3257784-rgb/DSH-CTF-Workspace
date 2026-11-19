# DSH CTF Workspace

独立的 Node.js 24 原型。普通 DSH 聊天不经过本工作区的总控检查。`npm test` 运行单元、集成及离线烟雾测试。测试需要存在 `data` 目录，并在其中创建临时任务。外部工具使用 `knowledge/metadata/tools.json` 登记的本机路径和指纹。

## 启动工作台

安装 Node.js 24 后运行 `npm start`，打开终端输出的完整本地链接。内置解码示例使用 Misc 类别和 `sample.b64`。原生运行时，外部工具需匹配工具清单里的路径和指纹。

完整环境需要支持 Linux 容器的 Docker 和 Compose。运行 `docker compose up --build`，打开日志中的完整链接。首次构建需要联网下载依赖，构建会检查工具可用性并运行测试。控制台使用本机 8080 端口，任务存入 Docker 卷。在线模型另需自己的服务地址和凭据。

## 接口

- Gateway 的 `createTask({ challenge_type, authorized_scope, budget_limit })` 返回冻结的任务决策。Web 的授权范围是一个明确的 `http://127.0.0.1:端口` 来源，其他题型使用 `local-only`。拒绝决策包含 `rejection_reason`。
- Executor 的 `execute(task, operationId, tool, input)` 只接受同一工作区签发的任务对象。Web 适配器接受 `{url}`，Crypto 适配器接受 `{ciphertext, key}`（十六进制与单字节 XOR 键），Misc 适配器接受 `{file}`（受信 fixture 目录内的 Base64 文件名）。Pwn 和 Reverse 可使用获准的静态文件头与字符串检查，动态执行未开放。每个任务最多一个在途操作。
- `pause(task)` 等待在途操作完成。操作失败时任务进入 FAILED。成功暂停后用 `resume(task)` 继续。同一任务和操作 ID 仅在规范化输入摘要匹配时复用结果。
- `finish(task, operationId, candidate, expected)` 将候选与成功操作证据关联，并用调用方提供的独立固定答案验证。单独的 `verifyFlag` 用于格式和固定答案判断。
- `createWorkspace(dataRoot, fixtureRoot)` 接受调用方控制的本地目录，默认 `data` 和 `fixtures/misc`。请在任务全部停止后调用 `close()`。活跃许可只存在于进程内。目录写权限应只授予受信本地调用方。
- `readEvidence(dataRoot, taskId)` 读取持久化 JSONL 证据。产物路径相对于该任务的证据目录。日志保留状态、错误类别和摘要，候选原文留在运行结果或转换产物中。
- `historicalStatus(dataRoot, taskId)` 用于历史检查。正常退出写入 INTERRUPTED。异常中断遗留的非终止记录按 RECOVERY_REQUIRED 展示。历史查询无法区分外部仍在运行的任务和已中断任务，查询活跃任务请使用 `status(task)`。历史记录不会签发新许可。
- 证据读取统一检查任务归属、记录链接、重复 ID 和时间戳。`historicalStatus` 遇到损坏 JSON 或无效证据链返回 `RECOVERY_REQUIRED`。
- Solver 返回前关闭其工作区，返回的任务快照与落盘状态一致。预算耗尽或需要补充信息的任务状态为 `INTERRUPTED`，不能凭旧许可继续；仅格式通过仍返回 `FORMAT_VALID`，其任务快照同样记录关闭状态。
- `searchKnowledge({type, tag})` 按题型和标签查询本地方法卡，最多五条，每条正文最多 4096 字符。预检的 `selected_method_card` 记录题型匹配，任务的 `knowledge_retrieval` 事件记录实际检索结果。要判断模型是否采用了卡片建议，需要结合会话响应和后续工具调用核对。

核心预算为每任务至多 20 次调用及 300 秒，Web 请求至多 5 秒，适配器输出上限 1 MiB。DSH 桌面入口限本地操作，每会话最多 6 次工具调用、90 秒，未开放 Web 通道。

DSH 返回的字符串值最多 8192 字符，Solver 模型反馈最多保留 1800 字符；`value_truncated` 标识值是否不完整。桌面许可过期后可查询同一会话的证据摘要，但不能继续执行或验旗。历史证据损坏的任务标记为 `RECOVERY_REQUIRED` / `INVALID_EVIDENCE`，不阻断其他任务列表，也不自动修复或重放损坏记录。
