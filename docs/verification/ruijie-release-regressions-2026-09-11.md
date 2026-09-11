# 锐捷Bot 开发/安装一致性回归记录（2026-09-11）

本记录不是发布通过凭据。未生成新的 Windows / macOS 安装包，未替换已安装文件，
未修改用户代理、VPN、登录凭据或线上 broker。全部可变测试使用独立夹具。

本文件按时间追加，前文“尚未修复/待复测”是当时的状态；当前结论以文末更新及
`发布交付指南/04-通用回归与发布门禁.md` 第 0 节为准，不删除历史失败来冒充一次通过。

## 入口与原始证据

- 当前 `C:/Users/Yunsh/Desktop/锐捷Bot.lnk` 指向
  `C:/Users/Yunsh/AppData/Local/Programs/openmausbot/OpenMausBot.exe`（安装版）。
- `锐捷Bot（本地开发版）.lnk` 指向源码的 `scripts/OpenMausBot.DevLauncher.exe`。
  其 `C:/Users/Yunsh/Documents/ChatGPT` 是指向 `D:/ChatGPT` 的 Junction，
  不是第二份源码；两条路径下 `electron/main.mjs` 的 SHA-256 一致。
- 开发日志 `AppData/Roaming/锐捷Bot/logs/server.log`：
  `2026-09-09T02:20:37.966Z connected-apps installation registered`；之前也曾失败。
- 安装日志 `AppData/Roaming/锐捷Bot Installed/logs/server.log`：
  `2026-09-10T22:59:12.890Z`、`22:59:56.358Z` 注册 `fetch failed`。
  历史注册成功不证明目前每个插件的实时授权/调用成功。
- `scripts/start-local-windows.ps1` 为 Node 设置系统代理环境；原安装入口不执行该脚本。
  原托管注册、服务端 catalog / OAuth / MCP 使用不同调用路径，不能把开发版通过
  当作干净安装版通过，也不能仅凭日志把全部失败归咎于 VPN。

## 云插件：修复和复验

桌面托管流量统一走独立 Electron Session 和私有 utility-process IPC，支持系统代理/PAC。
父进程固定 broker、注入凭据，禁止任意 URL、重定向和 cookie；限制体积/并发并支持取消。
首次无身份时离线会退避重试，网络恢复不要求重装；瞬时故障保留安装身份。
明确 401 后才失效重注册。界面区分网络不可达和服务错误。
自托管项目 key 的 Node 网络路径未在本轮改造。

```powershell
node node_modules/vitest/vitest.mjs run electron/managed-composio.test.mjs server/composio-transport.test.ts server/composio.test.ts server/composio-availability.test.ts scripts/build-windows-browser-vendor.test.mjs src/components/PluginsPanel.test.ts
node --test electron/managed-composio-transport.node-test.mjs electron/ruijie-package-config.node-test.mjs scripts/check-ruijie-release-readiness.node-test.mjs
node node_modules/typescript/bin/tsc -b
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node node_modules/electron/cli.js scripts/smoke-connected-apps-network.mjs
```

结果：6 个 Vitest 文件、58 项通过；传输测试 4 项、配置 3 项、门禁 2 项通过；两组类型检查通过。
OAuth 调用边界测试验证 JSON alias 和 content-type 不在转发时丢失。
扩展浏览器/飞书 runtime/配置检查另有 10 个 Vitest 文件、272 项通过。
扩展 Electron 检查发现 before-quit 测试夹具未注入新注册循环，出现两项 ReferenceError；
补齐夹具并断言退出时关闭注册循环后，飞书主进程 117 项全部通过。
完整所选 Electron 组复跑退出码 0（144 通过、3 跳过）。
Windows 的 save-file 符号链接测试有 3 项平台性跳过，不能算跨平台验收通过。
真实 Electron / utility-process 测试输出：

```json
{"ok":true,"platform":"win32","checks":["first-launch offline retry","real Electron session proxy","real utility-process IPC","catalog, OAuth and MCP share proxy","proxy changes recover without restart","stable installation identity"]}
```

这是本机模拟 broker / HTTP proxy / 合成 token，**不是真实外部账号授权**。
另行执行 `scripts/check-connected-apps-reachability.mjs`，无凭据、无注册写入：

```json
{"reachable":false,"route":["DIRECT"],"reason":"network-or-proxy-unreachable","authorizationVerified":false}
```

当前仍无法证明真实服务可达，更没有真实 OAuth + 一次只读调用的验收证据。
不能用 401、图标、mock、已有开发缓存替代。下一步需要可用的网络路径和明确授权的测试账号。
面向普通用户的稳定服务可能需要发行方 broker/域名；部署、费用和密钥管理未获授权，未执行。

## 打包形态服务端复验（不是生成安装包）

```powershell
node scripts/bundle-server.mjs
node scripts/smoke-packaged-server.mjs --browser-bundle 'D:/ChatGPT/Bot/downloads/OpenMausBot-source/dist-native/browser/win32-x64' --browser-default-enabled
```

通过：无可达 node_modules 时启动、13 个内置 proxy 路径、MCP stdio、关闭 stderr 后发现、
初始插件目录、内置浏览器自动发现/default-enabled。该测试仍使用原 `.1` 浏览器字节，
不证明没有终端或所有桌面 UI/云服务工作流通过。

## Windows 浏览器终端：独立问题

原安装资源复现命令（前序连续两次）：

```powershell
./scripts/verify-browser-no-console.ps1 -Resources 'C:/Users/Yunsh/AppData/Local/Programs/openmausbot/resources'
```

浏览器工作流退出码为 0，但捕获到 3 个新的 `CASCADIA_HOSTING_WINDOW_CLASS` 窗口，
所以无终端验收失败。外层 `windowsHide` 不控制 detached daemon 创建的控制台子进程。

新增 `.2` 补丁为 Chromium、嵌套 MCP 命令和 Git 探测设置 `CREATE_NO_WINDOW`。
保持原 stdio 补丁不变；源码/补丁/工具链均锁定。第一次本机候选构建时检查临时源码，
发现 Git 查到外层 `C:/Users/Yunsh` 仓库，`git apply --check --verbose` 实际输出四个
`Skipped patch`，退出仍为 0，源码版本仍是 `0.36.0`。该构建已按确切 PID 停止，未形成可交付候选。
新增实际 Git 嵌套目录回归测试，先得到 `expected upstream to be patched`，修正独立仓库边界、
LF 策略、反向校验和最终源码断言后，5 项构建测试通过；真实两份补丁应用后版本为 `.2`。
修正后的全流程构建已完成，候选为 `dist-native/browser-vendor-candidate-omb2`，
二进制 13,850,624 bytes，SHA-256 `775127b9d77326acf80478b484c0d9ce587bd47ae9390339c25f7e629bb05857`。
Rust 构建有 7 条上游 warning；没有作为零警告通过。原生无终端复测结果见下方追加记录。
正常下载 pins、开发 staging 和安装版仍是 `.1`。
候选编译通过不等于安装包通过，禁止覆盖旧 vendor 资产或填写假哈希。

## Mac 与发布门禁

Mac 飞书尚未移植完成：平台桥、CLI/Node 目标二进制、Mach-O/签名后验证和资源打包均需补齐。
未取得 macOS 实机，不能把 Windows 结果外推到 Mac。两种 Mac 架构均未通过发布验收。
四份原交付指南均链接到新增的 `发布交付指南/04-通用回归与发布门禁.md`。
Windows/Mac 的品牌配置在 beforePack 校验平台、源码工作树指纹、24 小时有效证据及运行时哈希。

```powershell
node scripts/check-ruijie-release-readiness.mjs win32-x64
```

当前正确阻断：`RELEASE BLOCKED: no verified win32-x64 receipt`。
指纹补充覆盖 public/build 静态资源、companion/enterprise/skills、tsconfig/Vite 等构建输入；
新增未提交资产变更测试先报 `Fingerprint missed public/icon.svg`，补齐后通过。
没有伪造 passed 凭据。新候选形成后仍须安装到隔离账号复验才能交付。
命名保持 `RuijieBot`，Mac ZIP 使用 `-mac-` 区分 Windows x64，避免同名覆盖。
三份修改的 workflow YAML 解析通过，`git diff --check` 通过（仅 Git CRLF 提示）。
全仓 i18n 检查仍有此前已存在的非本轮条目问题，不宣称全仓检查全部通过。

## 尚未满足的交付条件

1. `.2` 原生无终端复测、完整桌面浏览器接管/关闭按钮验收及可追溯资源接入。
2. 真实云服务授权与一次只读调用，以及 fresh-profile 重启/恢复。
3. 本轮完整 Windows 飞书/隔离安装验收，Mac 移植和各架构实机验收。
4. 全部预检完成后才生成安装候选，再验收实际安装产物；不承诺未经安装验证的“绝对无问题”。

部分 Electron 夹具退出时临时 profile 仍被锁而保留，另有被中断的 vendor scratch；
本轮显式临时目录清理请求被执行策略拒绝，未改用其他方式绕过。未删除用户数据或旧安装包。

## 用户现场追加：本地 08:57 搜索、红色断连和终端

截图 `codex-clipboard-b27d2b4d-e07c-4237-ab9e-acd97bf49522.png` 的右侧同时显示
“正在连接”“浏览器已断开连接”。按用户要求停止了自己的隔离 UI 测试，未关闭安装版。
当前安装版服务端 PID 29096，原生浏览器 PID 11348，对应用户 Bot 的 `.pid` 文件，
`.version` 明确为 `0.36.0-omb.1`。不把测试进程和用户进程混为一谈。

读取安装版 `server.log`、对应事件 NDJSON 以及 Harness 本次会话的压缩工具结果。
`session.jsonl.zstd` 是连续 Zstd 帧；逐帧按 `engine.bytesWritten` 前进解码，仅在内存读取。
实际本次会话 preset 为 `openmaus-browser-37a5bdd27b6babc7ef70`。

- 08:57:42 `browser_search` 返回 `Queued ... right sidebar browser; it will open when the sidebar connects`。
- 08:57:55 `web_search` 返回 Firecrawl **keyless free tier rate limit / out of credits**，不是 DNS 或网络超时。
- 同时 `browser_read_current` 返回右侧无可读取页面；08:57:59 `browser_open` 再次只入队。
- 08:58:25 本次挂载的 `agent_browser_open` 已返回 Bing 搜索标题；08:58:31 `read_page` 是 `local fetch, 200 OK`。
- 08:58:50 原生浏览器打开 AITNT 成功。08:59:01 get_text 出现 MCP -32001；同刻 Bot turn 为 interrupted，
  不能在排除取消影响前，把最后一个错误当成之前断连的根因。

因此：Harness 原有侧栏工具与 Bot 自己的浏览器入口发生混用已有直接证据；
通用搜索服务另有免费额度耗尽。目标网站并非全部不可达，不能统称 VPN 问题。
但具体画面流为何关闭仍待可重复原生复现，不能把“工具路由错位”当成整个断连的唯一原因。

Harness 08:58–09:01 另有 MCP `unauthorized` 重试 10 次后注销工具，已映射到
07:04 创建的旧 preset `openmaus-integrations-723a250f0ea900fe7ebf` 的 browser-proxy。
这是残留旧会话的生命周期问题，**不是本次正在调用的 MCP 实例**，不可错误归因。

新 `scripts/verify-browser-stream-lifecycle.mjs` 尚是诊断夹具：本次测试被用户现场请求打断，
初始画面检查结束为失败，但夹具服务已停止，不能作为独立根因复现证据或通过证据。
暂停运行会弹窗的 `.1` 原生测试，以免干扰用户正在使用的桌面。

## 追加：`.2` 候选两次无终端实测通过（仍不放行打包）

同一候选 SHA-256 `775127b9d77326acf80478b484c0d9ce587bd47ae9390339c25f7e629bb05857`：

```powershell
./scripts/verify-browser-no-console.ps1 -Resources 'C:/Users/Yunsh/AppData/Local/Programs/openmausbot/resources' -EngineCandidate 'D:/ChatGPT/Bot/downloads/OpenMausBot-source/dist-native/browser-vendor-candidate-omb2/agent-browser-win32-x64.exe'
```

连续两次均退出 0，`ok: true`、`fixtureExitCode: 0`、`newVisibleConsoleWindows: []`。
真实 MCP 冷启动、导航、标题、输入点击、同一 MCP 关闭重开、重启截图、双 Bot cookie/localStorage
隔离均通过。每轮自清理其独立 home 和浏览器。仅证明候选在此测试场景通过，
不证明完整 UI/安装产物通过。没有替换开发 staging、用户已安装浏览器或生成新安装包。

## 追加：用户指出 Harness 已调低 Firecrawl 优先级——已核实

当前运行的 Harness 为 `C:/Users/Yunsh/AppData/Local/Programs/Ruijie-Harness/Ruijie-Harness.exe`。
读取实际 `resources/app.asar`，版本 `2.1.6`；内含
`node_modules/@liustack/modsearch/dist/main.js` 与
`D:/ChatGPT/RuijieDSH/vendor/modsearch/dist/main.js` 逐字节一致，SHA-256
`a49c4eac7728c8688b25b71eb804bf1676c15d2aad4294d48d782e7a4803598d`。

搜索顺序为 `exa → tavily → antigravity-cli → firecrawl`；读取顺序为
`local → antigravity-cli → firecrawl`。因此不是这处补丁漏打包，但这是降级到最后，**不是禁用**。
Harness 的 `modsearch-provider-order.spec.ts` 明确测试这个顺序；其中注入的是合成测试 key，
不能证明普通安装用户配置了这些服务。

用已安装 Harness 的 Electron-as-Node 执行其内置 CLI `doctor --json`（只读、未发搜索），
投影输出仅保留引擎名、ready 和 reason：Exa/Tavily 无 key、`agy` 不在 PATH，
搜索最终解析为匿名 Firecrawl；fetch 解析为 local。`~/.modsearch/config.json` 不存在。
这个诊断子进程继承当前终端环境，不声称读取了运行中 Harness 的私有环境；
它与现场日志的 Firecrawl keyless 额度错误一致。模型/SSO 钱包余额不自动成为 Exa/Tavily key。

本次没有修改 Harness 源码或全局搜索配置。用户确认现有额度是 Harness 模型钱包，
不是 Exa/Tavily 搜索服务额度。后续采用下述仅作用于 Bot 会话的原生浏览器接入。

## 追加：Bot 自有搜索接入、后台收帧与 CI 预检

新增 `server/harness-browser-tools.ts`，作为独立模块随服务端打包，加载到 Bot 的 Harness
agent preset 内。该 preset 关闭原 `tool-web` search/fetch（保留 YAML `!!js` 平台判断和其他配置），
在当前 agent scope 注册 browser_search/open/read_current、web_search/fetch、read_page，
通过已有 scoped browser capability 调用同一 Bot 原生浏览器。没有修改其他 Harness 会话。
不触及 Exa/Tavily/Firecrawl key；不绕过人工接管，取消或失败后不自动换服务重试。
这些路由只在 Bot 挂载了自带浏览器的会话启用；没有挂载浏览器的会话保留原有行为。

失败先证实：原 adapter 测试 `mounts the built-in browser` 实际生成的 preset 仍含默认
搜索配置，缺 `search: false`；修复后对应测试通过。新增真实 proxy 边界测试覆盖两种搜索名、
页读取、参数拒绝、取消/接管拒绝。4 个测试文件共 47 项通过。

`scripts/verify-harness-browser-routing.mjs` 用实际安装的 Harness Electron-as-Node 加载它的
Cordis/tools/scope，在独立内存上下文与本地合成 broker 验证已打包的新模块。首次业务断言
通过但清理用了不存在的 `ctx.stop()`，退出 1；改用实际 `ctx.fiber.dispose()` 后整条命令退出 0。
验证了 scoped shadow 不影响全局侧栏，web_search 只调用原生 browser proxy，返回合成页面文本。
**这不是模型真实搜索/真实网页端到端通过**，也不是用户当前安装版已修复。

后台收帧新增失败测试：已经解码的相同画面序列遇到暂停的 `requestAnimationFrame`，
原组件 ACK 调用次数为 0。改为 effect 中确认已解码图片，不依赖动画时钟；未解码图片仍等待 load。
新增“连接失败后地址栏不得显示 Connecting”回归，先失败再修改已有本地化状态，复测通过。
相关 5 文件 88 项通过（包含前一版 panel 测试）；新增断开文案后所选 3 文件 16 项通过。
两组 TypeScript 检查通过，所改文件 oxlint 通过。

原生 UI 诊断脚本尚未通过：修正翻译选择器与真实键盘输入后，导航/持续画面验证仍超时。
期间部分运行有 Vite HMR、独立 CLI 检查重新启动了**测试**浏览器等干扰，不能认作现场完整断连根因。
保留失败截图及临时 Electron profile，停止本轮拥有的 fixture；没有停止用户应用。
后台 ACK 修复有独立回归证据，但仍需无热更新的真实 UI 持续观看/后台恢复验收。

再次执行 `node scripts/bundle-server.mjs`（仅 JS 构建，不生成安装包）以及
`node scripts/smoke-packaged-server.mjs --browser-default-enabled --browser-bundle dist-native/browser/win32-x64`
通过；14 个外部模块路径正确，node_modules 不可达时仍启动，MCP/插件初始目录/浏览器发现通过。
此项发现的仍是 `.1` staging，不替代 `.2` 资源接入和无终端验收。

用户提供 Mac 验证环境为 GitHub Actions。新增手动或 `codex/verify-ruijie-*` 验证分支推送触发、contents:read 的
`.github/workflows/verify-ruijie-prerelease.yml`：原生 arm64/x64 架构断言、源码检查、浏览器
依赖与原生测试、服务端构建形态及模拟代理恢复。没有安装包/签名/发布步骤，也不生成发布凭据。
YAML 本地解析通过；**尚未推送或触发远程 CI，不宣称 Mac 通过**。飞书移植仍未完成。
门禁新增独立搜索路由及后台画面恢复必需证据；四份指南通过通用指南继承此要求。

补充：`.2` 候选执行 `scripts/verify-browser-live-control.ts` 整条退出 0；初始帧、接管、
实际导航/点击/文本输入、拒绝连接恢复、挂起导航约 15.3 秒确认取消、交还再接管和 Enter 均通过。
这不包含 BrowserPanel 隐藏窗口的持续画面验收。后者的新独立运行仍导航检查超时，
截图显示地址已填而仍是空白新标签，未见红色断连；目前不能据此判定是产品导航还是夹具提交行为。
下一轮夹具需等待 React 的已提交 value 属性，不能只检查浏览器刚输入的 DOM value。
源代码收帧修复尚未获得完整 UI 通过证据。

再次只读探测真实 Composio broker 仍为 DIRECT/network-or-proxy-unreachable，未做授权。
GitHub 只读检查确认 `WYunS/OpenMausBot` Actions enabled、当前账号 ADMIN；未推送、未触发任务。
旧 `RuijieBot-0.1.73-setup.exe` SHA256 再次核实仍为
`01748F2B0C7BD6B86FB06BB8CEB68B94EC3223B37AEFDF7EF23B9664F907793D`。

收尾：搜索还必须检查原生 MCP `structuredContent.response.success === true`；
新增 Queued/原生失败不能算成功的回归先失败再通过，避免仅有文本就继续读旧页。
最新 5 文件 56 项通过。该检查新增时出现 TS18048（可选 result），补齐可选访问后，
前端 `tsc -b` 与服务端 `tsc -p tsconfig.server.json` **分别执行**均退出 0；独立 JS 构建退出 0。
此前多命令 PowerShell 的最终退出码不能替代各检查结果，以此处单独复核为准。
真实 Harness registry 隔离检查（含清理）退出 0。新接口只经过合成 broker/原生协议测试，
仍缺完整模型搜索真实网页、浏览器 UI 后台恢复、真实云插件及 Mac 飞书验收，不签发放行凭据。

## 续接：源码补齐，按用户要求暂不执行功能验证（2026-09-11）

本节新增/修改的源码、测试与流程均 **未运行测试、类型检查、构建、安装或 CI**。
前文通过记录属于更早的源码状态，不能作为本节变更的通过证据。不签发放行记录，
不生成 Windows/Mac 新安装包，不更新旧安装程序，不停止用户正在使用的应用。

### 用户确认的范围

- 云插件按服务自身网络要求使用，允许服务需要 VPN/代理；不要求本轮自建 broker。
  软件自身不能阻止连接，网络恢复必须能恢复注册/授权/调用入口。
- Mac 两项 MPL 例外扩展交由实施者决定：仅批准固定 Node 24.15.0 两架构中的
  smartstring 1.0.1 与 NSS 来源根证书数据，其他限制不变；依赖复核不是应用发布批准。
- 回复默认简体中文，用户明确要求其他语言时例外，不重写英文工具/工作空间约束。

### 已补源码和流程（尚未功能验证）

1. `buildSystemPrompt` 的稳定部分新增 response-language，覆盖直接对话、群组和提示词预览；
   驱动共用，不依赖每个 CLI 单独加一句。新增对应提示词/dispatch 用例和发布语言门禁。
2. Windows 浏览器生产 pin 改为已做过专项原生检查的 .2 精确字节，SHA
   775127b9d77326acf80478b484c0d9ce587bd47ae9390339c25f7e629bb05857。
   .2 尚未发布到远程 URL，prepare-browser 从明确本地 vendor/provenance 或精确缓存准备；
   缺失即失败、不下载旧 .1。vendor CI 的可变候选采用单独目录/candidate 清单，不能误作生产资源。
   本轮没有运行 preparation，磁盘旧 staging 和用户旧安装包不会自动变成 .2。
3. 浏览器流短断增加 1/2/5 秒最多三次重连，仅传输错误或服务端明确 retryable 时触发；
   断开清空画面/控制/输入队列，不重放动作、不自动恢复接管；30 秒稳定连接才重置次数。
   服务端增加不含 URL/内容/token 的关闭原因诊断。真实 BrowserPanel 工作流仍待验证。
4. Harness scope/capability 改变时仍必须重建会话，但重建后使用服务器有界 recoveryText，
   不再只把“继续”两个字交给空会话；已复用的会话不重复注入历史。
5. Mac 飞书补齐主进程、preload、renderer useFeishu 平台分支与中文提示，arm64/x64
   官方 CLI/Node 固定 pins、Mach-O 架构识别、tar.gz 安全单成员提取、PATH 分隔符、执行位、资源准备。
   打包形态缺/坏运行时立即报错，不回落 Homebrew/PATH/在线替换；签名前验哈希，签名后只允许
   完整主应用签名闭包和同一 Developer ID Team 的 helper 字节变化。新增权限/签名/归档/架构用例。
6. 发行服务地址作为公开 HTTPS 元数据烘焙到应用，资源管理器/Finder 启动不依赖打包终端环境。
   验收记录绑定实际 broker 地址；不嵌入项目 key、个人 token 或代理配置。
7. 插件恢复源码增量：主进程注册循环新增立即 retry、清退避并共享 in-flight；本机专用 IPC 不收 URL
   或凭据、不开放远程页面。刷新先等注册再刷新列表；失败库存不因已拿到 token 而停止轮询，
   stale 缓存不续期，后台强制读状态且避免重叠。提示首次网络失败时提供重试，不只引导改设置。
   保留已有身份及真实上游限制（例如需要自有 X 应用），不将所有授权失败都改成假成功。
8. 四份原指南与通用回归指南同步，预检 workflow 加入平台/许可/中文/恢复用例。
   未推送、未触发 GitHub Actions；未修改分支/提交历史或部署服务。

### 唯一新执行的检查：只读 Mac 制品/许可材料复核

`node scripts/audit-feishu-mac-artifacts.mjs` 退出 0，仅下载到内存并检查官方二进制/归档/同版源码，
没有执行下载的程序。两种 CLI 的 42 个模块中 41 个与已审版本/sum 相同，新增 go-keyring v0.2.8
保留 MIT、shellescape MIT 和 Darwin 文件 Apache-2.0 全文。Node 两种制品中均可见与既有审计
完全相同的 Amaro WASM Base64；同版根许可证字节一致。具体哈希、来源、限制及例外决策见
`connectors/feishu/licenses/MAC_AUDIT.md`，目标清单分别写入 manifest.targets。
这是模块/源码级许可工程记录，不是 Mac 执行/授权通过；没有把 Windows approved 自动用于 Mac。

### 下一阶段仍须完成

- 对本节工作树实际运行新增及既有回归、类型检查与隔离 fixture，修复发现的任何失败。
- .2 正常 staging 后重测 Windows 无窗口与完整 UI 的导航/后台/短断/关闭；dev 与 package-shaped 分别测。
- 实际 Harness 模型在同一可见浏览器内搜索真实网页/读取来源，无 Firecrawl 降级；验证中文默认与明确英文例外。
- 系统代理离线首启→恢复→注册重试→入口解锁→真实 OAuth→只读调用，以及既有身份的断网恢复。
- GitHub Actions 原生 Mac arm64/x64、飞书依赖准备与执行；真实授权/IM/工具只读和签名后运行/权限验收。
- 全部预打包证据满足后才可由用户决定生成候选；最终安装包仍需独立安装验收，不能提前保证绝对无问题。

## 开发快捷方式统一构建预览（2026-09-11 后续）

用户随后要求从“锐捷Bot（本地开发版）.lnk”直接看最新效果，并统一开发和安装行为。
该快捷方式指向 C:/Users/Yunsh/Documents/ChatGPT 下的 DevLauncher；该 ChatGPT 目录为
D:/ChatGPT 的 junction，确实是当前工作树，不是另一个旧源码副本。

本轮恢复执行构建和隔离验证，仍不生成安装器。引入 OMB_DESKTOP_PREVIEW：开发快捷方式
先校验/准备同版浏览器和飞书资源，再按源码指纹重建 dist 与 dist-server；Electron 使用编译后
server 和静态 UI，与打包所使用的文件相同。应用身份、开发端口和两个数据目录仍独立。
beforePack 验源码/构建文件树，afterPack 验实际复制进 Resources 的 UI/server；普通 Vite
调试入口保留，但不当作交付一致性证明。源码改变时已运行的任务不强杀，提示退出后重开。

实际发现并修复：

- prepare-browser CLI 动态导入 vendor，而 vendor 静态导回 prepare-browser，触发 unsettled
  top-level await。CLI 入口回归先失败，再将 build-only 导入延迟至实际 vendor build，复测通过。
- 残留 Vite 监听 dist-native 导致浏览器目录及新飞书目录 rename EPERM；只停止明确识别的
  本仓库闲置 Vite PID 4600 后，同命令均退出 0。Vite 忽略 dist-native，快捷方式改用静态预览。
- 飞书首次下载超时；现有旧 staging 的官方固定字节经哈希验证后复用，新 win32-x64 目录准备成功，
  未从用户账号目录取凭据或用不明版本代替。

已执行结果：前后端 TypeScript 分别退出 0；10 文件 188 项聚焦测试通过；独立 Node 26 项通过；
vendor/prepare 18 通过、1 个既有平台相关用例跳过；新构建一致性/快捷方式/配置检查18项通过，
补完快捷方式后相关13项再次通过。UI Vite 构建和服务端 bundle 已成功。
packaged-shape server 在 node_modules 不可达环境启动、14 个代理路径、MCP、catalog 与默认浏览器
发现 .2 通过。首次误传相对 --browser-bundle 被参数校验拒绝，改绝对路径后整条命令退出 0。
verify-browser-live-control.ts 使用 .2 + 内置 Chromium，临时 home/dataDir：初始帧、接管、
真实导航/点击/文本/Enter、拒绝连接恢复、约15.25秒挂起导航取消及重新接管全部退出0。
对应日志 C:/Users/Yunsh/AppData/Local/Temp/openmausbot-verification-evidence/server-1789094201230-31912.log。

这些结果仍不替代真实云插件授权、完整 BrowserPanel 后台持续观看、Mac 原生/签名后运行或最终安装验收。

预览交付：prepare-local-preview 退出0，源码指纹
b0027f578333c723f64133890950003afdd5d7116d4adebb13733b16bc98f05b；UI摘要
d65b5ef60767043b8bc28796c3f4c934664ee70ac621645dc08047d3a3447858；服务端摘要
12e559659afa6f3774e94bab54541ba68410fec5dd16b198579182e1c7a43f22。
通过用户指定快捷方式的真实 DevLauncher 启动，开发桌面 PID20876、所属 utility server PID34544；
38799/api/health 回应 static=true。只读获取主页与本地 dist/index.html 内容相同，
界面资产 index-DQeyl2Wc.js / index-BggxN_yG.css。桌面进程有窗口句柄且 Responding=true；
prepare.log 显示源码/产物匹配，启动 stderr 为空。未向用户真实聊天或插件发送测试操作。
开发应用留给用户查看，未生成安装包、未覆盖安装版数据。后续改源码会使该指纹失效，需退出后重开重建。

## 开发预览飞书与实时浏览器回归（后续修复）

用户反馈开发预览飞书失败、实时浏览器反复断开，要求开发版验收合格后才打包。

- 飞书：相同固定 CLI/Node 经 C:/Users/Yunsh/Documents/ChatGPT 的 junction 传入时，
  production provisioner 返回 UNSAFE_PATH；经物理 D: 路径加载成功。desktopRuntimeLayout
  现在仅解析受信任原生资源根路径，保留 MCP 所有权、服务路径与账号隔离。
  临时 home、禁止联网、真实固定二进制对照：raw-alias 仍 UNSAFE_PATH；fixed-layout 成功。
  Node layout/host/runtime 共 204 项：201 通过，3 项原有平台/可选制品用例跳过，不计通过。
- 导航：真实面板显示页面，但标签一直为新标签页/URL。原生导航回复只表示请求确认，
  现在等待相同 loaderId 的 DOMContentLoaded/load，原页面事件不能提前放行；统一15秒截止、
  超时后确认 stopLoading。再用原本的可信 tabId 重新选中同一页，让原生引擎刷新真实标题，
  不创建页面、不重新导航。新增测试先红后绿（11项通过）。
- 画面背压：大 JPEG 令 SSE 暂时阻塞时 tabs/url/status 被直接丢弃。新增回归复现空 tabs，
  现在最多缓存三种最新元数据，drain 后发送；控制权已交给另一 viewer 时不补发私密元数据。
  browser-live/navigation 合计75项通过，server TypeScript退出0。
- 实际 Electron BrowserPanel + 固定 .2 引擎：导航后像素改变、真实标题正确、隐藏窗口60秒
  无报错均通过。证据目录：
  C:/Users/Yunsh/AppData/Local/Temp/ruijie-stream-check-sTcN53，
  复测 C:/Users/Yunsh/AppData/Local/Temp/ruijie-stream-check-dtkboV。
  这不等于已复现用户真实联网搜索时的所有断连原因，不可声称绝对不会断线。
- 新增 verify-browser-runtime-lifecycle.ts：临时 home、真实 MCP 先启动浏览器，接入 viewer，
  MCP空闲回收后同一个流收到后续心跳，两次通过；未靠重连替代旧连接存活。
- prepare-local-preview 暴露新问题：headless-shell 的 Windows 子进程将 SSL 诊断写入
  chrome/chrome-headless-shell-win64/debug.log。整个清单因此不匹配，旧流程重装/重命名
  已使用目录并报 EPERM。只设置常见日志参数、环境变量、空设备或禁用日志的尝试均被真实
  TLS失败用例否决，相关运行参数改动已撤回。最终不抑制诊断：仅在全部发布文件仍一致时，
  将唯一已知额外普通日志归档到 dist-native/browser-runtime-logs，再执行严格制品校验。
  二进制改动、其他额外文件和链接不进入该归档路径；安装包完整性检查没有忽略日志。
  prepare-browser/browser-engine 63通过、1个Windows链接用例跳过。
- 最新真实控制测试含本地 TLS 故障、拒绝连接、约15.67秒挂起导航取消、随后接管/输入/Enter：
  退出0；所有Chrome发布文件未变。日志：
  C:/Users/Yunsh/AppData/Local/Temp/openmausbot-verification-evidence/server-1789097056104-29032.log。
- 放行门禁新增 desktop-preview-acceptance，且核对验收记录 desktopBuild.ui/server 与待打包
  文件树摘要。相同源码但重建产物变化也必须重新验收。新增断言先红后绿。

用户已确认保存并退出开发版，随后只刷新开发预览；不生成安装器。仍待用户真实使用验收、
云插件真实授权与只读调用、Mac Actions/原生/签名后验证，不补写任何“全部通过”的放行记录。

本轮最终预览构建退出0；再次 prepare-local-preview 命中同源码同产物，不再重装组件。
通过用户指定快捷方式启动，38799 所属 utility server PID36784，health.static=true，
实际首页与 dist/index.html 字节一致。源码指纹
c2e8a683ea1d83d50072a4a9fbcea41cccf245bfb48b5328db60871d61c18b53；
UI bedfc18e89a5dfda95963a41a341c146604afc67a79b362e1f6dc3bc3aba9b95；
server 6a1b0c3261d0065d9825422876fc5cceeb6208ebcb93f636ee5367d8c4f28867。
同版 bundle 的 packaged-shape smoke 再次退出0：无 node_modules 启动、14个代理路径、MCP末帧、
父stderr关闭后的电脑代理、24项原始插件目录和默认 .2 浏览器发现均通过。
未对真实用户聊天/授权执行测试操作，开发窗口留给用户验收。

## 用户再次报错后的对照诊断（未验收，不得放行）

用户截图仍出现 BOT_AUTH_REQUIRED 与实时浏览器反复断开。之前的隔离测试没有覆盖该故障，
不能把那些通过记录当作开发版或安装版已修复。此次没有生成安装包、没有刷新用户开发构建。

- 实际日志 03:27–03:30 UTC 有多次 `view-closed` 和一次 `native-stream-error`。
  现有泛化关闭原因不足以判断具体边界。用户开发进程于 03:36:30 UTC 正常退出；不是本轮诊断终止的。
- 新增 `scripts/verify-desktop-browser.mjs`：临时 HOME、完整已编译 UI、复制到仓库之外的已编译
  server、Electron 43.4.0 / Node 24.18.1 utilityProcess、桌面 owner header；不是 Vite/系统 Node。
  空白页 60 秒通过：Temp/ruijie-desktop-browser-XueFAJ。
  后台 native 导航至公开 Bing 搜索页面后 60 秒通过：Temp/ruijie-desktop-browser-tj1RGT。
  **覆盖仍不足**：该脚本没有跑真实模型的完整搜索工具链，没有复现用户现有 daemon 的失败，
  不得标记 desktop-preview-acceptance。早一次直接 native 导航漏传 headless/Chrome 设置，
  导致断流（Temp/ruijie-desktop-browser-5JUJ9m）；补齐设置后不再出现，属于夹具差异，不能冒称用户根因。
- `scripts/diagnose-browser-frame.ts` 只订阅已经存在的 loopback 流，不运行 CLI、不导航、不输入、
  不写文件，只输出帧格式/尺寸/接受与否，不输出画面或标签。一个现有用户流的首帧通过协议校验，
  另一个只收到 status 后超时。因此没有证据把所有断连归因于帧格式。
- 用户指定正常基准 `release/RuijieBot-0.1.73-setup.exe` SHA256 仍为
  01748F2B0C7BD6B86FB06BB8CEB68B94EC3223B37AEFDF7EF23B9664F907793D。
  只解压所需文件到 Temp/ruijiebot-good-installer-67c567d366b0484499ab7460c183ef3c，未执行安装器。
  它携带的 CLI 与当前固定 CLI 均为 SHA256
  39BA320129D7C700F907D0EA0D4A79467262A72CA0F971879F5F45CF5F782645；
  cli.mjs 均为 9782AFD7DBD3790B31C2DE3AD818BB0E6170DBE2999F987F6D3082E7F03BB9F6。
  Connector index 的差异只有四项错误文案，host 增加 macOS 支持，provisioner 改为包内组件优先。
  这些事实不能排除启动环境、时序和配置差异，也不能证明完整连接正常。
- `diagnose-desktop-feishu.mjs` 在独立 Electron profile 中只读解密现有配置选择，复制 CLI 配置
  到临时目录，运行新旧真实 connector 的 `probe`，kernel 和 store 写入均留在夹具内；
  两者 botAuthorized/userAuthorized 都为 true。**没有测试实际 IM 订阅、工具注册和用户授权流程**。
  `diagnose-feishu-identity.mjs` 的直连和正常环境身份校验通过；故意不可达代理返回
  CLI_NETWORK_ERROR，不是截图的 BOT_AUTH_REQUIRED。不能据此要求用户开 VPN。

剩余阻塞：截图对应的失败没有在同环境对照中稳定复现，现有日志丢失了飞书原始校验失败原因，
浏览器多数关闭原因也不够具体。需要补充边界诊断并捕获实际触发条件后才能修复、回归、放行。
本节任何绿色结果均不解除前述发布门禁。敏感配置副本已删除；正常安装器保留不动。

## 重复启动误报修复与飞书范围更新

- 用户随后明确反馈“飞书功能修好了”“飞书不用动了”。保留现状，不再修改飞书代码/授权/配置。
  这是用户本地使用确认，不推导为 Mac、安装后全流程或其他插件验收通过。
- 11:53:40 启动器记录 `Another startup is still in progress`，但首个启动在 11:53:55
  成功创建 Electron PID23348，随后 utility server PID22324 的 health.static=true，主窗口响应。
  因此本次截图是重复启动等待 60 秒后误报，不是仍然持有的死锁。没有结束用户应用。
- `scripts/start-local-windows.ps1` 改为非阻塞取得启动锁：未取得者不重复启动也不弹失败；
  实际启动失败先释放锁、再显示错误，旧弹窗不再长期占锁。快捷方式每次读取该 PS1，无需重编译启动器 exe。
- 新增真实 PowerShell 隔离并发回归：慢启动期间第二次点击、失败弹窗期间重试。
  改动前 2/2 失败（重复点击/重试退出 1）；改动后与原启动器检查合计 13/13 通过。
  命令：`node --test electron/local-windows-launcher-concurrency.node-test.mjs electron/local-windows-launcher.node-test.mjs`。
  仅独立命名 mutex、临时文件、模拟启动/弹窗动作；不操作真实应用或安装版。
- 未生成安装包，未重启当前窗口，也没有据此宣称浏览器断连已解决。

## 实时浏览器断连：已复现的 daemon 配置冲突与源码修正

本节替代“尚未找到浏览器关闭原因”的状态，不改变飞书范围，也不签发发布放行。

### 失败循环与最小原因

1. 在隔离 HOME 中运行真实引擎，先开 BrowserLive，再调用真实 MCP `agent_browser_open`：
   `node --experimental-strip-types scripts/verify-browser-runtime-lifecycle.ts --viewer-first`。
   原生变量指向 `dist-native/browser/win32-x64/agent-browser.exe` 及同目录 headless-shell。
   修正前连续失败，约 7–8 秒出现 `native-stream-error` / `native-stream-closed`，
   `MCP launch/navigation must not close the existing viewer` 断言失败。
2. 单独初始化 MCP / tools/list 不断流；把 MCP idle 从 2 秒改成 60 秒，导航仍立即断流，
   排除了“空闲回收误杀”作为本次原因。仅把工具端默认超时与 viewer 对齐则通过。
3. 原生 `connection.rs::daemon_config_fingerprint` 包含 `default_timeout`。
   `BrowserLive.command` 只给 viewer 增加 `AGENT_BROWSER_DEFAULT_TIMEOUT=15000`，
   MCP / 截图则没有；两端操作交替会让原生引擎因配置不同重启 daemon。
   因此模型搜索可以完成，但画面流被关闭；自动重连又切回另一配置，连续操作可耗尽三次重试。
   这是应用配置冲突，不能归因 VPN、免费搜索额度或图片解码。
4. 两条单元断言（默认缺省 / 明确 7300）在修正前均失败：viewer 都错误变成 15000。
   修正只移除 viewer 私自覆盖，保留统一 spec；导航仍由独立 CDP deadline 在约 15 秒取消，
   CLI 仍有进程 watchdog，没有通过取消超时来掩盖问题。

### 为什么之前测试漏掉了

旧完整桌面夹具手写 direct CLI 环境时也补了 15000，恰好抹掉生产 MCP 与 viewer 的差异。
同时只判断 `picture=true`，自动重连后的新画面也会被算通过。
现改为真实 MCP → 嵌套 CLI，并通过 Electron Network 记录原 SSE 连接数与错误，要求
始终只有一条原连接、没有流错误、收到多帧。不能给测试工具额外补生产环境没有的设置。

旧编译 bundle 在改正后的完整 UI 测试中确实失败：
`Temp/ruijie-desktop-browser-607YtX`；MCP 搜索返回成功、画面恢复，但
`The original stream must survive, not silently reconnect` 断言失败。
这说明此前“空白页/公开搜索页 60 秒通过”的记录不能作为本次故障的有效修复证据。

### 修复后已验证与边界

- 同一原生循环：viewer-first 和 MCP-first 均通过，每种三轮真实人工接管/导航/交还/MCP，
  并在 MCP 空闲回收后收到原流心跳；不是用新连接替代旧连接。
- 定向回归首次 109 项通过；扩大路由检查后 113 项通过、2 项条件跳过，跳过不计验收。
  `node node_modules/typescript/bin/tsc -p tsconfig.server.json` 退出 0。
- `verify-browser-live-control.ts` 再次通过拒绝连接、挂起导航约 15.27 秒取消、随后真实 DOM
  输入/Enter/接管交还。日志：
  `Temp/openmausbot-verification-evidence/server-1789100640139-22972.log`。
- 修正后的 server 打成独立临时 bundle，替换隔离夹具的 server entry；没有覆盖当前用户构建。
  第一轮 `Temp/ruijie-desktop-browser-SUbPjM` 连续 60 秒，原 SSE 1 条、55 帧、0 错误。
  该轮的 reload 标签匹配遗漏，且全局 `aria-pressed` 误匹配到父级“浏览器”选项卡，
  不能声称完成了三轮真实交还或 reload。随后三个夹具（nkGqrI / 85GLuW / CXC3XA）
  将缺按钮改为硬失败，均在夹具选择器处失败，原流仍只有 1 条且无错误。
  最终按明确的“接管浏览器 / 交还机器人”可访问名称定位控件并等待真正结束 pending，
  不再以任意 pressed 按钮判定已接管；继续完整复测，不把这些夹具失败改写为产品成功。
- 四份发布/验收指南补齐两种启动顺序、共享 daemon 配置、原流不重连判断；macOS Actions
  增加两种原生生命周期检查，但本机没有执行 Mac runner，不把 Windows 结果冒充 Mac 通过。
- 本轮临时 Node inspector 已关闭、定点断点移除、三个临时调试脚本删除；没有结束用户的
  Electron PID23348 / utility PID22324，没有修改用户网页、授权或飞书。
- 正常旧安装包 SHA256 再验仍为
  `01748F2B0C7BD6B86FB06BB8CEB68B94EC3223B37AEFDF7EF23B9664F907793D`，未生成任何新安装包。

当时用户仍运行旧构建；已请求保存并完全退出后再刷新同一开发快捷方式。
隔离 candidate 通过不等于当前旧窗口已更新，不补写 desktop-preview-acceptance 或最终安装凭据。

### 完整编译桌面复测结果

修正真实控件定位后，`Temp/ruijie-desktop-browser-maqWK2` 退出 0：
真实 MCP 搜索、三轮真实接管/刷新/交还后 MCP 读取均成功，随后原连接连续 60 秒；
`connections: 1, frames: 28, maxFrameBytes: 111883, errors: []`。
`verification.json` 和 `server.log` 在上述目录；测试过程中不使用用户数据或模型额度。

命令（PowerShell）：

```powershell
$env:OMB_VERIFY_SERVER_ENTRY='C:/Users/Yunsh/AppData/Local/Temp/ruijie-browser-fixed-build-4ed3faa0f4fc47878dee653d2c0951a5/index.js'
node node_modules/electron/cli.js scripts/verify-desktop-browser.mjs
```

候选 server entry SHA256：`46e4a1bbb1fc6015e3041805a536b6b5800cad17e2ae26ef28c80f9cf10ed62b`。
它由当前 `server/index.ts` 及依赖构建，测试实际 Electron 43.4.0 / Node 24.18.1 utilityProcess，
不是把系统 Node 或 Vite 的结果当桌面结果。当轮用户的 `dist-server/index.js` 尚未覆盖，
需要正常退出开发版并通过现有准备流程重新构建；重新构建的正式预览仍须跑同一完整脚本。

最后复测将原生 CLI 配置显式锁定到夹具自己的空 managed config，排除用户/项目配置干扰：
`Temp/ruijie-desktop-browser-i1wsWH` 再次退出 0，三轮实际接管/刷新/交还与 MCP 读取，
随后连续 60 秒，`connections: 1, frames: 27, maxFrameBytes: 105687, errors: []`。
构建指纹/发布门禁的 3 项 Node 回归也通过；没有写入任何放行凭据。

## 用户重启后的正式开发预览核对（13:01 启动）

用户反馈“已退出并重新登陆了”后进行只读核对与隔离复测，没有再次结束其进程。

- 原桌面快捷方式仍指向 junction 下的同一仓库；13:00:58 UTC+8 自动重建完成，
  13:01:04 创建新主进程 PID35608，utility server PID26380。
  `http://127.0.0.1:38799/api/health` 返回 `static:true` 与该 utility PID。
- `node scripts/desktop-build-receipt.mjs` 在复测前后均退出 0；源码指纹
  `f783c33a6f7152e49ce24b2a65fbddde66fdfab009bedd4615ded019a0ed28eb`，
  UI 摘要 `bedfc18e89a5dfda95963a41a341c146604afc67a79b362e1f6dc3bc3aba9b95`，
  server 文件树摘要 `9269a2aa86d529264c0cbbc6cbc8d1422bc3ecec78476443fd5e14a4a85037b0`。
- 正式 `dist-server/index.js` SHA256 与之前通过验证的修复 entry 完全一致：
  `46e4a1bbb1fc6015e3041805a536b6b5800cad17e2ae26ef28c80f9cf10ed62b`；
  编译代码确认 viewer 不再单独注入默认超时。
- 使用正常命令 `node node_modules/electron/cli.js scripts/verify-desktop-browser.mjs`，
  **未设置 `OMB_VERIFY_SERVER_ENTRY`，没有临时替换入口**。它复制的就是当前正式预览产物。
  `Temp/ruijie-desktop-browser-m8G05S` 退出 0：真实 MCP 搜索、三轮实际接管/刷新/交还后的
  MCP 读取，随后原流连续 60 秒；`connections:1, frames:29, maxFrameBytes:90923, errors:[]`。
  原始证据为该目录下 `verification.json` / `server.log`。
- 当前窗口现已加载修复构建，可直接继续用户验收，不需要再次退出。隔离操作没有触及用户
  聊天、网页或账号；飞书未修改，未打包，也未把此项浏览器结果扩写为整个产品/Mac/安装版放行。

## 用户确认后的源码交付与剩余边界

用户随后确认本地开发版测试无异常、飞书正常，要求先更新四份指南再同步到
WYunS/OpenMausBot 的 main；没有要求本轮生成新安装器。保留所有正常功能，不再修改飞书账号或实现。

- 对应真实搜索会话正常完成，中文规则确实进入 Harness 本轮请求；实际仅调用 Bot 的
  browser_search/browser_open，preset 的原 tool-web search/fetch 均为 false。
  但一次中文搜索只读到导航/页脚，一次外站打开超时，过程中有英文进度，欢迎语仍为硬编码英文。
  因此分别记录工具返回、有效正文、语言注入与语言遵守，不声称所有细节零错误。
- 同时段 Harness 日志只有技能重复/名称格式警告，不能用旧 Electron server.log 证明本轮零错误。
  用户后续认为开发版可用，也不推导为每个云插件、每个平台或最终安装版均已验收。
- 只读提取当前开发 electron.exe 图标确认是默认 Electron 原子；Windows ICO 的 5 个尺寸、
  Mac ICNS 的 7 个尺寸逐一与产品 PNG 匹配，运行时 app-icon.png 与 Mac 1024px 素材一致。
  图标素材仍受 Git 跟踪且未回退；没有为开发图标修改运行时、身份或重新打包。
- 用户明确 Mac 反馈为“屏幕录制”重复授权。目前没有受影响 Mac 的完整弹窗、签名对照或
  TCC 复现日志，不能确认是签名根因，更不能写成已修复。已将同版重复截图/退出重开/覆盖升级
  的独立验收和 embedded/standalone CUA 责任进程核对加入四份指南及签名策略。
- 当前修复分支是 WYunS/main 的后继，未发现远端 main 独有提交。源码同步采用普通快进推送，
  不触碰作者 origin。关闭旧 Release 的 main/package.json 自动触发，Docker 分支任务限制为
  构建/检查，避免同步代码隐含创建安装器或发布镜像；手动发布仍需单独审查上游残留规则。
- 更新指南/工作流会使源码指纹变化，已有指纹是历史证据；没有手写或更新机器放行凭据。
  下一次开发快捷方式按正常流程校验/准备，打包者按最终 SHA 重新生成和验收相应构建记录。

### 本次同步前检查

- 前端 `node node_modules/typescript/bin/tsc -b` 与服务端 `tsc -p tsconfig.server.json` 均退出 0。
- 12 个聚焦 Vitest 文件共 213 项通过：浏览器 live/navigation/engine、Harness 浏览器路由与语言、
  Composio 传输、画面 ACK/面板、云插件面板和飞书 renderer 平台选择。
- 13 个 Node 测试文件共 119 项通过、3 项跳过：Mac/Windows 运行时与许可规则、路径隔离、
  签名验证规则、快捷方式并发、私有代理传输、打包配置/源码凭据。Mac 测试中的模拟命令不算原生执行。
  两项 Windows 文件符号链接权限不可用和一个可选官方制品 smoke 跳过，没有计入通过。
- 新的 main 同步安全回归先因旧 Release 的 push 触发失败；改为仅手动并约束 Docker 发布为 tag 后通过。
  没有启动任何 GitHub 打包/发布流程来验证该规则。
- 5 份交付文档 Markdown 围栏和 7 个相对链接检查通过；全部 workflow YAML 可解析。
  暂存差异的空白检查通过；原生补丁中必要的单空格上下文标记按 unified diff 格式单独检查，
  未改动已固定哈希的补丁字节。对相对 WYunS/main 的 440 个源码/文档文件做高置信凭据模式扫描，
  未检出匹配项；不把模式扫描当作所有形式敏感信息的证明。
- 本轮没有重跑全仓 lint/i18n 或全部平台套件，不声称全仓 CI 已通过；没有安装/打包、
  没有改用户正在运行的功能、登录、网络或权限状态。
