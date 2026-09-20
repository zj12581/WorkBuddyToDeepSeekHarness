# WorkBuddy 余额插件(DSH)

在 DeepSeek Harness 里加一个 `/balance` 命令,显示账号剩余积分。

```
/balance

WorkBuddy balance — www.workbuddy.cn

  2,352.63 / 3,000.00 credits remaining  (78.4%)
  647.37 used

  Packages
    2,352.63 / 2,500.00  94.1%   CodeBuddy个人版国内运营裂变包  ×9   (next cycle ends 2026-10-15)
    0.00 / 500.00  0%   CodeBuddy个人体验版   (next cycle ends 2026-09-30)
```

## 安装

```bash
bash integrations/dsh/install-balance-plugin.sh          # 默认装进 web profile
bash integrations/dsh/install-balance-plugin.sh headless # 或指定 profile
```

脚本做三件事:把插件复制到 profile 的 `node_modules`(这样 Node 能按裸包名解析,和 DSH 解析自己的插件一样),往 `cordis.patch.yml` 加一行 loader 行,再验证一次能否按名字 import。重复执行是安全的 —— 已经装过就只报告,不重复加行。

装完重启 DSH,或依赖 profile 的 `patchReload: live` 自动重载。

## 它读什么

余额来自上游 `POST /v2/billing/meter/get-user-resource`,和桌面端用的是同一个接口。每个套餐同时有两组计数:

| 字段 | 含义 |
|---|---|
| `Capacity*` | 套餐**生命周期**总量 |
| `CycleCapacity*` | **当前计费周期**剩余 |

插件用 `Cycle*`。这两组会不一致:实测有个套餐 `CapacityRemain` 显示 500,而 `CycleCapacityRemain` 是 0 —— 那个包本期已经用完了。只看 `CapacityRemain` 会得出"还剩 500"的错误结论。

## 几点行为

- **只读。** 这个接口不写任何东西,插件也从不触发 token 续期。token 过期时命令会说明情况,让你去跑一次桌面端或网关 —— 为了显示一个状态去改另一个程序的会话文件,不值当。
- **缓存 30 秒。** 上游这个接口有结算延迟(连续查询返回的数字会有小幅差异),所以快速重复查询没有意义,而斜杠命令很容易被连按。
- **同名套餐合并。** 一个账号常见持有十几个同名的赠送包,逐条列出会刷屏。插件按套餐名求和,后面标 `×N` 表示由几个包合成。

## 文件

```
plugin-workbuddy-balance/
  package.json      包清单(type: module, main: lib/index.js)
  lib/index.js      插件本体:登录态定位、billing 请求、渲染
install-balance-plugin.sh   安装脚本
```

插件不引用网关仓库里的任何代码,可以单独拷走。

## 环境变量

| 变量 | 作用 |
|---|---|
| `WORKBUDDY_AUTH_FILE` | 直接指定登录文件,跳过自动探测 |
| `WORKBUDDY_AUTH_DIR` | 指定要搜索的目录 |
| `DSH_HOME` | DSH 主目录(安装脚本用,默认 `~/.dsh`) |

## 排查

**`Could not read the WorkBuddy balance: no login file found`**

桌面端没登录,或会话在非常规位置。用 `WORKBUDDY_AUTH_FILE` 指过去。

**`the access token expired at ...`**

用桌面端发一条消息,或向网关发一次请求(两者都会续期),然后再试。

**`the billing response had no Accounts array`**

上游响应结构变了。改 `lib/index.js` 里的 `fetchBalance()`,把新的字段路径接上。
