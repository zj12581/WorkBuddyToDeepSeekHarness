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

## 参数

| 参数 | 作用 |
|---|---|
| 无 | 按套餐汇总的余额,结果缓存 30 秒 |
| `--json` | 输出 JSON,给脚本用(`/balance --json \| jq .totalRemain`) |
| `--refresh` | 绕过缓存,强制重新查询 |

未知参数返回错误并给出用法,不会静默忽略。

剩余不足 15% 时,输出里会多一行提醒。

## 安装

```bash
bash integrations/dsh/install-balance-plugin.sh          # 默认装进 web profile
bash integrations/dsh/install-balance-plugin.sh headless # 或指定 profile
```

脚本把插件复制到 **`$DSH_HOME/profiles/node_modules`**,往该 profile 的 `cordis.patch.yml` 加一行 loader 行,再验证能否按裸包名 import。重复执行是安全的 —— 已经装过就只报告,不重复加行。

> **注意目录是 `profiles/node_modules`,不是 `profiles/<profile>/node_modules`。** DSH 从 profiles 那一层解析插件名(它自己的本地插件也都在那儿);装进 profile 自己的目录,文件会在磁盘上,但加载器找不到,`/balance` 静默不生效。

装完重启 DSH,或依赖 `patchReload: live` 自动重载。

> **改了插件源码后要重新同步。** 安装脚本是复制而非软链,`~/.dsh/profiles/node_modules/` 下那份不会跟着仓库变。重新跑一次安装脚本即可。

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
