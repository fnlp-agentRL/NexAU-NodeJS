# 飞书机器人全新重构开发文档（OpenClaw 协调层 + NexAU 运行时）

文档状态：Draft v2  
更新日期：2026-03-14  
适用范围：全新项目（不兼容、不复用 `examples/example_project`）

## 1. 目标与硬约束

本项目采用“网关-运行时”双层架构：

- 飞书协调层（Gateway）借鉴/复制 OpenClaw 的成熟实现思路（事件接入、去重、回包、卡片事件、Webhook 安全策略）。
- 模型推理与工具调用层（Runtime）使用 NexAU-NodeJS。

硬约束（必须满足）：

1. 新项目**不引入原版 `openclaw` npm 包**。
2. 新项目会安装并使用：

- 当前本地 `NexAU-NodeJS`
- `@larksuite/openclaw-lark`

3. 新项目除真实飞书入口外，还提供一套 **HTTP 伪装飞书消息入口**，用于压测、回放、联调和故障复现。

## 2. 结论与总体方案

该方案可行，并且比当前 example 项目稳定：

- 不再依赖 `openclaw` 的运行时私有函数（避免 `core.channel.* is not a function` 一类问题）。
- Gateway 只做“消息接入/标准化/路由/回包”，不做 LLM 调用。
- Runtime 只做 NexAU Agent + 工具调用，不关心飞书连接模式（WS/Webhook/HTTP 模拟）。

## 3. 技术选型与依赖策略

## 3.1 依赖清单

必选依赖：

- `nexau-nodejs`（本地路径安装）
- `@larksuite/openclaw-lark`
- `@larksuiteoapi/node-sdk`
- `fastify`（或 `express`）
- `zod`（协议校验）
- `pino`（结构化日志）
- `dotenv`

明确不安装：

- `openclaw`

## 3.2 代码来源策略（“参考 openclaw，但不依赖 openclaw 包”）

在新项目中建立 `vendor/openclaw_feishu_ref/`，复制并改造 OpenClaw 的飞书相关实现思想，不直接 import `openclaw/plugin-sdk`。

重点参考目录（来自 `~/Frontiers/openclaw/extensions/feishu/src`）：

- `client.ts`（Feishu Client/WS Client 创建与缓存）
- `monitor.ts`（事件监听、webhook 安全、fire-and-forget 策略）
- `dedup.ts`（消息去重）
- `outbound.ts` + `send.ts`（消息发送与媒体回包）
- `card-action.ts`（卡片事件转“合成消息”）
- `types.ts`（事件结构）

说明：

- 可以复制逻辑，但要删除对 `openclaw/plugin-sdk` 的依赖，改为项目内 `gateway-core`。
- 所有被复制代码必须加来源注释、版本标记和二次封装边界。

## 4. 新项目目录设计

```text
feishu-nexau-bot/
  apps/
    gateway/                          # 飞书协调层（WS/Webhook/HTTP模拟）
    runtime/                          # NexAU 运行时（Agent + tool calling）
  packages/
    protocol/                         # 网关与运行时共享协议
    gateway-core/                     # 从 openclaw 思路改造后的最小网关内核
    toolkit-feishu/                   # openclaw-lark 工具注册与适配
    observability/                    # logging/tracing/error code
  vendor/
    openclaw_feishu_ref/              # 参考实现快照（只读，不直接执行）
  docs/
    feishu-openclaw-nexau-dev-guide.md
    feishu-app-setup.md
    gateway-http-sim-api.md
```

## 5. 核心架构

## 5.1 Gateway（重点）

Gateway 负责三类入口统一化：

1. Feishu 长连接入口（主入口）
2. Feishu Webhook 入口（备份入口）
3. HTTP 伪装飞书消息入口（测试/回放入口）

三类入口都进入同一条处理链：

`Ingress -> Normalize -> Dedup -> Route -> RuntimeClient -> Outbound`

### 5.1.1 Gateway 子模块

- `ingress/ws.ts`：接收 `im.message.receive_v1`、`card.action.trigger` 等事件。
- `ingress/webhook.ts`：验签、限流、body 大小限制、快速 ACK。
- `ingress/http-sim.ts`：接收模拟事件并转为标准事件。
- `normalize/feishu-event.ts`：将 raw event 规范化为 `InboundEnvelope`。
- `dedup/store.ts`：基于 `message_id/event_id` 幂等去重。
- `router/dispatcher.ts`：将消息路由到 Runtime。
- `outbound/reply.ts`：文本/图片/文件/线程回复。

### 5.1.2 Gateway 设计原则

- 单一职责：不做 LLM，不直接执行业务工具。
- 同构处理：真实飞书事件与 HTTP 模拟事件走同一逻辑。
- 可回放：任意事件可保存并重放。
- 可观测：每一步有结构化日志。

## 5.2 Runtime（NexAU）

Runtime 负责：

- NexAU Agent 执行
- 会话历史管理
- 工具调用循环
- 错误收敛与最终回复生成

Runtime 不负责：

- 飞书 SDK 事件监听
- 飞书回调协议处理

## 5.3 Toolkit（openclaw-lark）

使用 `@larksuite/openclaw-lark` 提供飞书工具能力，按域组织：

- Messenger
- Docs
- Base
- Sheets
- Calendar
- Tasks

同时做一层 `tool adapter`：

- 统一工具输入输出
- 统一错误码映射
- 标准化 `traceback/error_type/error`

## 6. HTTP 伪装飞书消息接口（重点）

## 6.1 设计目标

用于本地调试、自动化测试、故障复现，不依赖真实飞书客户端发消息。

要求：

- 支持模拟 `p2p/group/thread` 场景。
- 支持模拟多种消息类型（text/post/image/file/merge_forward/card_action）。
- 支持注入固定 `message_id`，用于去重测试。
- 支持“仅入队不执行”与“执行并等待结果”两种模式。

## 6.2 API 清单

1. `POST /gateway/simulate/feishu/message`
2. `POST /gateway/simulate/feishu/card-action`
3. `POST /gateway/simulate/feishu/event`（泛化入口）
4. `GET /gateway/simulate/schema`（返回 JSON Schema）

## 6.3 请求示例：模拟文本消息

```json
{
  "account_id": "default",
  "mode": "sync",
  "event": {
    "event_type": "im.message.receive_v1",
    "sender": {
      "open_id": "ou_test_user"
    },
    "message": {
      "message_id": "om_sim_001",
      "chat_id": "oc_test_chat",
      "chat_type": "p2p",
      "message_type": "text",
      "content": { "text": "请创建一个实验记录多维表" }
    }
  },
  "options": {
    "bypass_dedup": false,
    "dry_run": false,
    "expect_reply": true
  }
}
```

## 6.4 返回示例

```json
{
  "trace_id": "trc_xxx",
  "accepted": true,
  "dedup": { "hit": false },
  "runtime": {
    "status": "ok",
    "elapsed_ms": 1532,
    "reply_preview": "已为你创建多维表..."
  }
}
```

## 6.5 安全策略

模拟接口默认仅本地可用：

- `SIM_HTTP_ENABLED=1` 才启用
- 仅监听 `127.0.0.1`
- 要求 `X-Sim-Token`
- 可选 IP 白名单

生产环境默认关闭。

## 7. Gateway 与 Runtime 协议

## 7.1 Gateway -> Runtime

`POST /v1/runtime/respond`

```json
{
  "trace_id": "uuid",
  "source": "feishu_ws",
  "account_id": "default",
  "session_key": "feishu:oc_xxx",
  "sender_open_id": "ou_xxx",
  "chat": {
    "chat_id": "oc_xxx",
    "chat_type": "p2p",
    "thread_id": null
  },
  "message": {
    "message_id": "om_xxx",
    "message_type": "text",
    "text": "你好"
  },
  "meta": {
    "received_at": "2026-03-14T14:00:00.000Z",
    "locale": "zh-CN",
    "timezone": "Asia/Shanghai"
  }
}
```

`source` 可取值：

- `feishu_ws`
- `feishu_webhook`
- `feishu_http_sim`

## 7.2 Runtime -> Gateway

```json
{
  "trace_id": "uuid",
  "status": "ok",
  "reply": {
    "type": "text",
    "content": "你好，我可以帮你创建文档和多维表。"
  },
  "meta": {
    "iterations": 2,
    "tool_calls": 1,
    "latency_ms": 1240
  }
}
```

## 8. 工具调用与错误处理规范

- 所有工具调用日志必须输出：
- `tool_name`
- `tool_args_preview`
- `has_error`
- `error_type`
- `error`
- `traceback`

- 对 `anyOf/oneOf` 参数 schema，禁止预先过滤掉 `action` 等关键字段。

- 错误码建议统一：
- `TOOL_VALIDATION_FAILED`
- `TOOL_PERMISSION_DENIED`
- `TOOL_REMOTE_API_ERROR`
- `RUNTIME_LLM_ERROR`
- `GATEWAY_DISPATCH_ERROR`

## 9. 飞书能力范围

本项目首期必须覆盖：

- Messenger：读消息、回帖、发送、检索、下载图片/文件
- Docs：创建、读取、更新
- Base：app/table/field/record/view（含批量与过滤）
- Sheets：创建、读写、追加
- Calendar：日历与事件 CRUD、参会人、free/busy
- Tasks：任务/任务清单/子任务/评论

## 10. 环境变量设计

## 10.1 Gateway

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_ENCRYPT_KEY`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_CONNECTION_MODE=websocket`
- `FEISHU_WEBHOOK_PORT=8000`
- `SIM_HTTP_ENABLED=1`
- `SIM_HTTP_PORT=18080`
- `SIM_HTTP_TOKEN=xxxx`

## 10.2 Runtime

- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_TIMEOUT_SECONDS=90`
- `AGENT_TIMEOUT_SECONDS=60`
- `AGENT_RETRY_ATTEMPTS=1`

## 10.3 Common

- `LOG_LEVEL=info`
- `LOG_DIR=./logs`
- `LOG_JSON=1`

## 11. 日志与可观测性

日志文件：

- `logs/gateway-YYYYMMDD-HHMMSS.log`
- `logs/runtime-YYYYMMDD-HHMMSS.log`

建议事件序列：

1. `event.received`
2. `event.normalized`
3. `event.dedup.checked`
4. `runtime.request.sent`
5. `agent.llm.requested`
6. `agent.tool.called`
7. `agent.tool.completed`
8. `runtime.reply.received`
9. `feishu.reply.sent`

## 12. 实施计划（14 天）

第 1-2 天：

- 初始化新仓与目录
- 协议包 `packages/protocol`
- Gateway 基础 HTTP 服务 + 日志

第 3-5 天：

- 接入 Feishu WS
- 接入 Webhook 备份模式
- 完成去重与标准化

第 6-7 天：

- 接入 Runtime（NexAU）
- 跑通“收消息 -> 调用 runtime -> 发回复”闭环

第 8-10 天：

- 接入 openclaw-lark 全量工具域
- 完成工具错误码统一和日志增强

第 11-12 天：

- 实现 HTTP 模拟飞书消息接口
- 补齐压测与回放脚本

第 13-14 天：

- e2e 联调
- 故障演练（授权失败、超时、重复消息）
- 发布文档与运行手册

## 13. 验收标准（DoD）

1. 不安装 `openclaw` 也能完整运行。
2. 实际飞书消息与 HTTP 模拟消息都能驱动同一处理链。
3. 六大能力工具可用，且失败时日志可直接定位。
4. 30 分钟稳定压测无“函数不存在”类兼容错误。
5. 新同学按文档 30 分钟内可本地跑通。

## 14. 风险与规避

风险 1：复制 OpenClaw 代码后漂移

- 规避：`vendor/openclaw_feishu_ref` 只读快照 + 定期对比脚本。

风险 2：openclaw-lark 与 runtime 协议不一致

- 规避：tool adapter 层统一出入参，不把三方对象直接泄露给 Agent。

风险 3：模拟接口被误用到生产

- 规避：默认关闭 + 本地监听 + token 校验 + 环境门禁。

## 15. 下一步落地建议

按以下顺序开工：

1. 先实现 `apps/gateway` 的三入口统一管线（WS/Webhook/HTTP 模拟）。
2. 再实现 `apps/runtime` 的 NexAU 最小闭环（1 个工具即可）。
3. 最后批量接入 openclaw-lark 的六大工具域。
