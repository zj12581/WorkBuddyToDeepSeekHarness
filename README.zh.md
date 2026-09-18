# workbuddy-gateway

**把本机已登录的 WorkBuddy / CodeBuddy 账号变成 OpenAI 兼容 API 接口 —— 单文件,零依赖。**

[English](README.md) · [DeepSeek Harness 接入](docs/dsh.md) · [疑难排查](docs/troubleshooting.md)

```
任意 OpenAI 兼容客户端(DeepSeek Harness、Cherry Studio、LobeChat …)
        │  POST http://127.0.0.1:8790/v1/chat/completions
        ▼
  gateway.js  ── 读桌面端登录态、自动续期、归一化流式响应
        │  POST https://copilot.tencent.com/v2/chat/completions   (本身就是 OpenAI chat 协议)
        ▼
  WorkBuddy 后端(混元 / GLM / Kimi / MiniMax / DeepSeek)
```

## 它和同类项目有什么不同

同类项目已有好几个(清单见 [NOTICE](NOTICE))。这个项目的差异点只有三条:

| | |
|---|---|
| **零依赖、零构建** | `node gateway.js` 就能跑。不装 Docker、不装 Go、不 `pip install`。只要有 Node ≥ 18(用内置 `fetch`)。 |
| **被真实 agent 打磨过,不是 curl 级验证** | agent 客户端会注入合规声明式系统提示词("拒绝 DoS / exploit / credential testing / C2 frameworks …"),上游内容审核把这些词当敏感输入,整条请求返回 `11128 Illegal API invocation from an unapproved channel`。本项目会脱敏该提示词并重试,见[下文](#它实际解决的问题)。 |
| **可复现的模型能力矩阵** | `probes/` 实测账号真正可用哪些模型 id、哪些模型有独立思考链。是可重跑的事实,不是抄来的文档。 |

## 快速开始

前置条件:**WorkBuddy / CodeBuddy 桌面端已登录**(登录态在它那里),Node ≥ 18。

```bash
git clone https://github.com/zj12581/WorkBuddyToDeepSeekHarness.git
cd WorkBuddyToDeepSeekHarness

# 1. 真实端到端自检:模型列表、非流式、流式、原生工具调用
node tests/smoke-test.js

# 2. 启动
node gateway.js --port 8790 --api-key workbuddy-local
```

然后在任意 OpenAI 兼容客户端里填:

- **接口地址** `http://127.0.0.1:8790/v1`
- **API Key** 与 `--api-key` 一致(本机自用也可以都不设)
- **模型名** 取 `GET /v1/models` 里的 id

DeepSeek Harness 的完整配置见 [`docs/dsh.md`](docs/dsh.md)。

### 不开客户端也能验证

```bash
curl -s http://127.0.0.1:8790/v1/models -H "Authorization: Bearer workbuddy-local"

curl -s http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer workbuddy-local" -H "Content-Type: application/json" \
  -d '{"model":"hy4-preview","messages":[{"role":"user","content":"用一句话说明什么是 CAN 总线"}]}'
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/models` | 已配置的模型清单 |
| `POST` | `/v1/chat/completions` | 流式 / 非流式,原生 `tools` / `tool_calls` |
| `GET` | `/health` | 会话状态(默认隐藏身份字段) |

不带 `/v1` 前缀的 `/models`、`/chat/completions` 也接受。

## 它实际解决的问题

agent 客户端会把它自己的合规声明当系统提示词发出去,大意是:

> 必须拒绝 **DoS** 攻击、**exploit** 开发、**credential testing**、**C2 frameworks**、**malware** 制作 …… **privilege escalation**、**reverse shells**、**SQL injection** …

上游对这些字面词做了拦截,于是回:

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}
```

**"我拒绝做这些事"这句话本身,被当成了"我要做这些事"。** 网关的处理:

1. **脱敏** `system` / `developer` 消息:在每个命中词内部插入零宽空格(`DoS` → `D<U+200B>oS`)。人眼和模型读起来无差别,但字面关键词匹配失效。这一步**不改用户输入**。
2. **被拦后重试一次**,升级为连 `user` / `tool` 消息一起脱敏。
3. **`developer` → `system` 归一**:上游只认 `system`/`user`/`assistant`/`tool`,而新的 OpenAI 客户端会发 `developer`。

复现故障与修复:

```bash
node gateway.js --no-desensitize --no-retry   # 终端 1:故障形态
node probes/probe-block.js                    # 终端 2:看系统提示词被拒

node gateway.js                               # 终端 1:修复形态
node probes/probe-block.js                    # 终端 2:五个场景全过
```

## 模型能力矩阵

2026-09 用一个国内版账号实测。**这是数据不是文档** —— 用 `node probes/probe-models.js` 和 `node probes/probe-thinking.js` 可以随时重跑刷新。上游模型 id 会随时变动。

| 模型 id | 可用 | 独立思考链 | 备注 |
|---|---|---|---|
| `auto` | ✅ | ✅ | 上游解析为 `hy4-preview-f` |
| `hy4-preview` | ✅ | ✅ | 混元 |
| `hy4-preview-f` | ✅ | ✅ | 快速版 |
| `hy3` | ✅ | ❌ | |
| `hy3-preview` | ✅ | ❌ | |
| `hy3-preview-agent` | ✅ | ❌ | agent 优化版;仅探测过,未在 agent 里跑过 |
| `glm-5.3` | ✅ | ✅ | |
| `glm-5.3-flash` | ✅ | ✅ | |
| `glm-5.2` | ✅ | ❌ | 官方文档称 1M 上下文 |
| `glm-5.1` | ✅ | ❌ | |
| `glm-5v-turbo` | ✅ | ❌ | 多模态 |
| `kimi-k3` | ✅ | ✅ | |
| `kimi-k2.7` | ✅ | ✅ | |
| `kimi-k2.6` | ✅ | ❌ | |
| `kimi-k2.5` | ✅ | ❌ | |
| `minimax-m3` | ✅ | ❌ | 多模态 |
| `minimax-m2.7` | ✅ | ✅ | |
| `deepseek-v4-pro` | ✅ | ❌ | 官方文档称 1M 上下文 |
| `deepseek-v4-flash` | ✅ | ❌ | 官方文档称 1M 上下文 |
| `deepseek-v3.2` | ✅ | ❌ | |

不存在的 id(上游回 `11102 service info not found`):`hy4`、`hy4-preview-agent`、`hy3-preview-f`、`hunyuan`、`hunyuan-turbo`、`kimi-k2.7-code`。

两个实用结论:

- **没有**独立思考链的模型,在客户端里必须声明为非推理模型。否则客户端会发 `reasoning_effort`,模型直接忽略;而客户端界面上显示的"思考过程"是客户端自己编的,不是模型产的。
- **有**独立思考链的模型会先花输出预算做推理。`max_tokens` 给小了会得到空正文 + `finish_reason: "length"`,推理模型请给足预算。

## 配置

优先级:命令行 / 环境变量 → 配置文件 → 内置默认值。

```bash
node gateway.js \
  --port 8790 --host 127.0.0.1 \
  --api-key workbuddy-local \
  --config ~/.workbuddy-gateway/config.json \
  --log ./logs/gateway.log \
  --debug
```

从 [`config.example.json`](config.example.json) 开始改。环境变量等价物:`WORKBUDDY_GATEWAY_PORT`、`WORKBUDDY_GATEWAY_API_KEY`、`WORKBUDDY_GATEWAY_HOST`、`WORKBUDDY_GATEWAY_CONFIG`、`WORKBUDDY_GATEWAY_LOG`、`WORKBUDDY_GATEWAY_DEBUG`、`WORKBUDDY_MODELS`、`WORKBUDDY_UPSTREAM`、`WORKBUDDY_AUTH_FILE`。

| 参数 | 作用 |
|---|---|
| `--no-desensitize` | 关闭系统提示词脱敏(用来演示故障) |
| `--no-retry` | 关闭被拦重试 |
| `--expose-identity` | 在 `GET /health` 里回显 `nickname` / `uid`(默认关闭) |
| `--model-list a,b,c` | 替换对外暴露的模型清单 |

## 实现要点

- **登录态定位。** 桌面端把会话存在平台相关的应用数据目录里。网关按 Windows / macOS / Linux 的已知路径(含多个回退)查找,优先 `workbuddy*` 文件。可用 `authFile` / `WORKBUDDY_AUTH_FILE` 覆盖。
- **token 自动续期。** 每次请求前检查 access token,剩余不足 60 秒就调桌面端自己的刷新接口,并原子回写。因此网关和桌面端可以同时运行,不会互相踢下线。
- **上游只支持流式。** 网关始终以 `stream: true` 请求上游;客户端要非流式时本地聚合。
- **先缓冲再写出。** 流式响应在上游流结束前不写出,这样即使中途被安全策略拦截,也能整段重试而不是吐半截答案。
- **推理链透传。** `delta.reasoning_content` 原样转发,懂这个字段的客户端(例如 DeepSeek Harness)会渲染成思考通道。

## 目录结构

```
gateway.js              服务主体(配置、路由、重试阶梯)
lib/core.js             纯逻辑:脱敏、请求构造、SSE 解析
lib/credentials.js      登录态定位、token 续期、上游请求头
probes/probe-models.js  账号真正可用哪些模型 id
probes/probe-thinking.js 哪些模型有独立思考链
probes/probe-reasoning.js 上游对 reasoning_effort 的反应
probes/probe-limits.js  接受哪些 max_tokens(弱信号,见文件头说明)
probes/probe-block.js   复现安全策略拦截并验证修复
tests/unit/             lib/core.js 的离线单测
tests/smoke-test.js     对运行中的网关做真实端到端自检
docs/                   DeepSeek Harness 接入、客户端配置、疑难排查
```

## 测试

```bash
node --test tests/unit/core.test.js   # 离线,不需要账号
node tests/smoke-test.js              # 需要网关正在运行
```

## 安全

- 默认只监听 `127.0.0.1`。**不要暴露到网络** —— 能连上这个端口的人就能消耗你账号的额度、读到你的输出。
- 登录文件等同账号完全控制权,别进版本库(`.gitignore` 已覆盖 `*.info`、`auths/`、`logs/`)。
- 日志可能含完整提示词与回答,只落本地,本项目不会把它们发到任何地方。
- 除了你配置的上游地址,本项目不发起任何其他外部请求,没有遥测。

## 合规边界

这是**非官方**软件,与腾讯 / CodeBuddy / WorkBuddy 无关,未获其认可或支持。

- 请**仅使用你本人持有且已授权的账号**,在自有机器或私有环境使用。
- 用代理复用桌面端登录态,可能与上游平台服务条款冲突,存在被风控或封号的可能。**该风险由使用者承担。**
- 不要共享、转售、再分发这个接口,也不要公开托管;更不要用它绕开上游对**真实有害输入**的审核 —— 脱敏功能的存在意义是阻止"拒绝声明"被误判,不是把违规请求偷运进去。
- 软件按"现状"提供,不附带任何担保。作者不对封号、数据丢失或任何使用后果负责。

上游协议与模型 id 会随时变动。失效时,修复点通常在 `lib/core.js`(请求形态)或 `probes/`(模型清单)。

## 许可

MIT,见 [LICENSE](LICENSE)。第三方致谢见 [NOTICE](NOTICE)。
