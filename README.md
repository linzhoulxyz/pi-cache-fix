# pi-cache-fix

为 Pi 的 OpenAI Responses 兼容服务补充 `session-id` 请求头的小型扩展。

零运行时依赖，不绑定供应商，不改 Pi 安装包，不包含 API key。通过显式站点白名单启用：未配置时不修改任何请求。

## 它修复什么

一些兼容服务无法正确识别 Pi 原生发送的 `session_id`，可能导致同一会话的提示词缓存读取异常。这个扩展在允许的站点上，使用 Pi 当前会话 ID 补充连字符形式的 `session-id`。

```text
Pi -> before_provider_headers -> add session-id -> Responses endpoint
```

扩展只添加一个缺失的请求头，保留原来的 `session_id`。已有的 `session-id`（不区分大小写，包括显式删除值）不会被覆盖。切换会话后使用新的会话 ID。

**这不是本地答案缓存、缓存用量修改器或独立代理服务器，不能保证所有供应商都会命中缓存。**

## 两台 PC 上安装

前提：已经安装 Pi 和 Git，并配置好需要使用的 **`openai-responses` provider**。已在 Pi 1.4.0、Node.js 22.23.3 上验证；当前 Pi 要求 Node.js >= 22.19.0。其他 Pi 版本需要支持 `before_provider_headers` 扩展事件。

每台 PC 执行相同的安装命令：

```powershell
pi install git:github.com/linzhoulxyz/pi-cache-fix
```

然后指定需要修复的实际 API 站点。Windows PowerShell 示例：

```powershell
$origins = "https://www.wgpt123123.xyz"
[Environment]::SetEnvironmentVariable("PI_CACHE_FIX_ORIGINS", $origins, "User")
$env:PI_CACHE_FIX_ORIGINS = $origins
pi
```

第一条设置让以后新启动的进程可用，第二条设置让当前 PowerShell 立即可用。如果从另一个已经打开的终端或桌面客户端启动 Pi，需要重启那个父进程，使其读取新环境变量。

进入 Pi 后输入：

```text
/cache-fix
```

显示 `active for ... (openai-responses)` 表示当前模型满足启用条件；该命令不发起模型推理请求。`pi list` 只能证明包已配置，不能证明当前模型匹配或上游缓存已经命中。

Linux/macOS 对应的当前终端设置：

```bash
export PI_CACHE_FIX_ORIGINS="https://api.example.com"
pi
```

环境变量不包含密钥，可以在两台 PC 上复用。供应商认证仍由每台 PC 的 Pi provider 配置管理，不要把认证文件上传到这个仓库。

## 配置规则

只有一个配置项：`PI_CACHE_FIX_ORIGINS`，多个 origin 用逗号分隔：

```text
https://api.example.com,https://another.example.com,http://127.0.0.1:3425
```

- 使用实际请求 `baseUrl` 的 origin，即协议、主机和端口，不含 `/v1` 等路径。
- 严格匹配 origin，不使用域名后缀匹配或通配符；端口和协议不同也视为不同站点。
- 可以省略或保留末尾 `/`，默认端口和大小写按 URL 规则规范化。
- 路径、query、fragment、账号密码和非 HTTP(S) 地址会报配置错误；错误信息不会回显原始配置值。
- 默认没有生效站点，不隐式启用所有供应商。
- 修改配置后重启 Pi。插件不会新增 provider、切换模型或把 Chat Completions 转换为 Responses。

如果使用本地网关，应配置网关的 origin，而不是其背后的供应商站点。**允许添加请求头不等于网关一定会透传它；本项目尚未完成 Magpie 路径的真实缓存回归。**

## 为什么不绑定某个供应商

修复针对的是会话身份头的兼容行为，而不是供应商品牌。新站点可以通过同一个配置项启用，不需要修改代码；但应先确认它接受 `session-id`，再比较原始缓存 usage，不能把在一个站点的成功自动推广到其他站点。

当前只处理 `openai-responses`，不会修改 `openai-completions`、独立的 `openai-codex-responses` 或其他协议。

## 更新与回滚

更新 Git 安装源：

```powershell
pi update git:github.com/linzhoulxyz/pi-cache-fix
```

该命令只更新这个安装源；希望固定版本时，可以使用确认存在的 commit 或 tag 安装，不要假设本仓库已经发布 tag。

临时停用（当前 PowerShell）：

```powershell
Remove-Item Env:PI_CACHE_FIX_ORIGINS -ErrorAction SilentlyContinue
pi
```

卸载包并清理专用环境变量：

```powershell
pi remove git:github.com/linzhoulxyz/pi-cache-fix
[Environment]::SetEnvironmentVariable("PI_CACHE_FIX_ORIGINS", $null, "User")
Remove-Item Env:PI_CACHE_FIX_ORIGINS -ErrorAction SilentlyContinue
```

重启 Pi 后生效；provider 配置和会话数据不需要删除。

## 验证情况与限制

修复来源于 2026-10-29 对 WGPT `gpt-6.1-sol` 的一次受限测试，原始缓存 usage 与 Pi 解析值一致：

| 方式 | 三次请求的 cached_tokens |
| --- | --- |
| 原生 Pi Responses 适配器 | 0, 0, 0 |
| 只补 session-id | 0, 17152, 17152 |
| 只补正文会话元数据，未作为本插件实现 | 0, 17152, 17152 |
| 完整 Pi CLI 加 session-id，含一次真实 read 工具调用 | 0, 15104, 15232 |

这是对修复机制的短程实测，不是对所有站点、所有模型或长期稳定性的保证。没有确认是哪个服务端组件导致了差异，也没有证明必定存在 Nginx 丢头。泛化后的包通过离线测试和本地假服务验证，不额外消耗供应商请求。

首条冷请求为零、缓存过期、服务端路由变化、上下文压缩或前缀变化，都可能使读取为零；不要把单次零缓存直接判断为插件故障。

## 开发验证

无需安装依赖：

```bash
npm run check
npm test
npm pack --dry-run
```

可选：使用已安装的 Pi CLI，在隔离临时目录中安装本地包，向仅监听本机回环地址的假 Responses 服务发送一次合成请求，再卸载。不会连接模型供应商，不修改日常 Pi 配置，也不会递归删除临时证据目录。

```powershell
$env:PI_CACHE_FIX_PI_CLI = "C:\Program Files\nodejs\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
npm run test:pi
```

这个路径只是本机安装示例，应替换为目标 PC 上的 Pi CLI JavaScript 入口；该路径不参与扩展运行。

也可以验证 Git 安装源；此时会连接 GitHub 下载扩展，但模型请求仍只发往本机假服务：

```powershell
npm run test:pi -- git:github.com/linzhoulxyz/pi-cache-fix
```

仓库只作为 Git 分发包，暂未发布 npm 包或选择开源许可证。
