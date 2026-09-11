# 锐捷 Bot：Windows 打包指导

> 2026-09-11：先执行 [通用回归与发布门禁](04-通用回归与发布门禁.md)。
> 用户已确认本地开发版测试无异常；浏览器真实 MCP/完整桌面断流回归已通过。
> 此确认只覆盖本地开发版，不代替新安装包、Mac 或每个云应用的独立授权验收。
> 品牌打包入口有 `beforePack` 门禁；缺当前工作树/原生运行时的通过记录会主动报错。
> 已修复项与未测边界统一见通用指南第 0 节；不沿用 `.1` staging 或旧源码的通过记录。

本文件可直接交给另一位打包者。只针对 **Bot**，不是锐捷 Harness；不要使用
Harness 的 Yarn、2.1.6 版本号、DSH profile 或打包脚本。
与本目录另外三份编号指南及 Mac 签名策略配套使用。交付状态更新：2026-09-11。

## 1. 取得唯一交付源码

公开仓库：<https://github.com/WYunS/OpenMausBot>。
正式交付入口为该仓库的 `main`，不是作者 `milind-soni/OpenMausBot` 的 `main`。
`codex/openmaus-upgrade-0.1.71-ready` 是此前修复分支，不再作为唯一下载入口。
本仓库 Release 只允许手动触发；普通 main 推送仅同步源码/运行检查，不授权打包或发布。
发布工作流仍含上游发布/镜像假设，必须另行审查后才可手动执行。
打包前固定最终完整 commit SHA，Windows、Mac 必须使用同一 SHA，而非各自构建移动中的 main。

在自己选择的父目录运行（已有检出则不要重复 clone）：

```powershell
git clone --branch main https://github.com/WYunS/OpenMausBot.git OpenMausBot
Set-Location -LiteralPath ./OpenMausBot
```

以下命令要求 **PowerShell 7.4+、Windows x64、Node.js 24.x、Corepack**。
pnpm 版本由 package.json 的 `packageManager` 锁定，当前为 10.33.0。
不要用碰巧在 PATH 上的 pnpm 11 代替，它会忽略旧位置的跨架构依赖配置。

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repoRoot = (git rev-parse --show-toplevel).Trim()
Set-Location -LiteralPath $repoRoot
git status --short
git rev-parse HEAD
git remote -v
node --version
node -p 'process.arch'
corepack pnpm --version
node -p 'require("./package.json").version'
```

当前 Bot 版本为 **0.1.73**；正式版本以当前 SHA 的 package.json 为准。
不能把 Harness 的 2.1.6 填进去，不能为让命令通过临时修改版本号或锁文件。
同版本若已公开发布且字节不同，须先协调新版本提交，禁止覆盖既有资产。
已有改动归原作者所有；不要 reset、强制 checkout 或删除用户数据来清场。

## 2. 打包前必读

- 发布配置必须用根目录 `electron-builder.ruijie.mjs`，它读取上游完整资源规则，
  并设置锐捷更新源、产物名、连接服务地址及验收门禁。标准 `pnpm package:win` 已强制使用该配置；
  不要绕过它改用默认 `electron-builder.yml`，也不要运行上游 Release/镜像发布工作流。
- 产品窗口、快捷方式和 Windows“已安装的应用”/卸载列表都叫“锐捷Bot”；Windows
  安装器和压缩包的产物前缀为 `RuijieBot`。兼容身份仍为 `com.openmausbot.app`，
  内部 productName 仍为 `OpenMausBot`；卸载显示名由 `nsis.uninstallDisplayName`
  单独固定。不要擅改 App ID 或安装目录。
- 安装版服务数据目录是 `%USERPROFILE%/.ruijiebot`；源码开发版继续使用
  `%USERPROFILE%/.openmausbot`，两者不得混用。Electron 自身的窗口、浏览器缓存仍按
  Windows 规则位于 `%APPDATA%/锐捷Bot Installed`，不等同于 Bot 服务数据。
  不迁移、合并、覆盖或复制开发版 `.openmausbot`。
  不要复制加密凭据文件来做迁移，不要将个人 profile、Gmail、飞书 token 打入包。
- `enterprise/` 使用单独许可证，不是 Apache-2.0；打包脚本在目录存在时会带入它。
  内部生产使用、对外分发、白标的授权应由发布负责人核实，保留 LICENSE/NOTICE，
  不得绕过许可检查。源码上传不等于获得安装包再分发授权。

## 3. 不需要从零编译所有第三方组件

Electron、Chromium、agent-browser、CUA、cloudflared 使用锁定的预编译发行文件。
正常打包不需要装 Rust 去重编译浏览器，也不需要重编译 Harness。
依赖仓库缓存、下载缓存可复用，但最新 Bot 的 UI、server、companion、updater
必须重新生成。旧 release/win-unpacked 不是新源码的构建结果。

标准可复现路径（不清空整个工作区或下载缓存）：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
node --test electron/ruijie-package-config.node-test.mjs electron/local-windows-launcher.node-test.mjs
corepack pnpm test:packaged-server
corepack pnpm package:prepare
corepack pnpm build:cua:windows
corepack pnpm build:feishu:windows
corepack pnpm exec electron-builder --config electron-builder.ruijie.mjs --win --x64 --publish never
```

`package:prepare` 包含 UI/server/companion/updater、Android 工具、cloudflared、
浏览器资源准备；`build:feishu:windows` 会把固定版本且经过 SHA-256 校验的
`lark-cli 1.0.93` 与 `Node.js 24.15.0` 放入安装包。任何一步非零退出就停止，
不能跳过 afterPack，也不能删除这一步后继续打包。
仅在同一 SHA、锁文件、平台、配置和生成物都有可核对构建记录时，才允许续跑
最后的 electron-builder；换人、换提交或生成物来历不明，一律重新生成自己的 JS。
下载失败时修复网络/代理或提供脚本支持的校验缓存，不关闭 TLS 或哈希校验。

Windows 浏览器必须是 `0.36.0-omb.2`，不能使用会弹终端的 `.1` 或未修复 stdio 的上游 0.37.0。
当前 `.2` 尚未发布下载地址：从交付人取得已核对的 vendor 目录（exe、provenance），
通过 `OMB_BROWSER_VENDOR_DIR` 指定绝对路径；当前开发目录默认读取
`dist-native/browser-vendor-candidate-omb2`。生产准备脚本核对固定 SHA
`775127b9d77326acf80478b484c0d9ce587bd47ae9390339c25f7e629bb05857` 和来源记录。
缺少正确字节会阻断，不回退到旧引擎；不要填造尚不存在的 GitHub release URL。
重新编译候选若字节不同，先走候选原生验收再审阅更新 pin，不以关闭哈希检查解决。
飞书 staging 现在按架构分目录：`dist-native/feishu-runtime/win32-x64`，包内路径不变。
发行方如使用自己的插件服务，以 `RUIJIE_COMPOSIO_BROKER_URL` 设置公开 HTTPS 地址；
该地址会写入包内元数据，验收记录必须绑定同一个地址，不能依赖安装者机器的环境变量。
Mac/Linux 则使用源码各自的 pin。完整 staged tree 包含 agent-browser、Chrome
Headless Shell、manifest 和 licenses，不能只复制一个 exe。
默认 Windows 无代码签名，准确报告“未签名”；不得添加虚假的 publisherName。

## 4. 检查实际打出的资源，不只检查文件名

```powershell
$resources = Join-Path $repoRoot 'release/win-unpacked/resources'
@('app.asar','app-update.yml','ui/index.html','server/index.js',
  'server/ruijie-computer-proxy.js','companion/index.js','cua-driver.exe',
  'cloudflared/cloudflared.exe','browser-engine/manifest.json',
  'browser-engine/agent-browser.exe','tuantuan-feishu/index.mjs',
  'tuantuan-feishu-runtime/manifest.json',
  'tuantuan-feishu-runtime/lark-cli-1.0.93-windows-amd64/lark-cli.exe',
  'tuantuan-feishu-runtime/node-24.15.0-win-x64/node.exe') |
  ForEach-Object { if (-not (Test-Path -LiteralPath (Join-Path $resources $_))) { throw "Missing resource: $_" } }
Get-Content -LiteralPath (Join-Path $resources 'app-update.yml')
node scripts/smoke-browser-bundle.mjs --resources $resources
$env:OMB_SMOKE_DIST = Join-Path $resources 'server'
try { node scripts/smoke-packaged-server.mjs --browser-default-enabled --browser-bundle (Join-Path $resources 'browser-engine') }
finally { Remove-Item Env:OMB_SMOKE_DIST -ErrorAction SilentlyContinue }
```

`app-update.yml` 必须为 GitHub / owner WYunS / repo OpenMausBot。
浏览器 smoke 必须实际运行，`--check-only` 只算结构检查。
另须按通用指南第 2 节运行 MCP 优先及 `--viewer-first` 两种启动顺序，并在完整编译桌面中
执行真实 MCP 搜索、三次接管/交还和连续 60 秒原流检查；不能给测试工具额外注入超时参数掩盖断连。
额外的最小源码回归：

```powershell
corepack pnpm exec vitest run server/browser-navigation.test.ts server/browser-live.test.ts server/browser-runtime.test.ts server/drivers/ruijie-harness-local.test.ts server/drivers/ruijie-harness.test.ts server/retained-computers.test.ts src/components/BrowserPanel.test.ts src/components/ModelPicker.test.ts src/components/SidebarBotListItem.test.ts
```

完整 HTTP 回归命令为 `corepack pnpm exec vitest run server/index.test.ts`，可能需要数分钟。
跳过项应写明原因。通过源码测试不等于安装版验收通过。

## 5. Windows 安装版真人验收

使用专用测试系统账户；只有获得本次授权才安装/覆盖，先备份该测试账户。

1. 安装 `release/RuijieBot-<版本>-setup.exe`，从安装快捷方式打开，不从源码脚本打开。
   记录程序路径、版本、SHA。安装目录无源码/node_modules 仍能启动；Windows
   “已安装的应用”/卸载列表显示“锐捷Bot”，不得显示 OpenMausBot。
2. 启动有 RJ 加载反馈，不应长时间无解释黑屏；登录页写锐捷Bot。普通启动不弹出
   Harness 窗口，也不把已安装未运行的 Harness 置灰或挡住模型列表。
3. 另行安装兼容 Harness（本轮接口基线 2.1.6），它不包含在 Bot 安装器中。
   主动用 Harness 发消息才启动后台桥接；使用安装版账号额度，不硬编码开发路径。
   默认 V4 Flash / low，Bot 固定 none/low/medium/high/xhigh/max 档位向合法值映射。
   含图片的请求不可误发非视觉模型；每个 GPT/Claude/DeepSeek 抽测必要档位和图片。
4. “没有电脑”和“这台电脑”分别打招呼；后者实际执行一项无害截图/输入工具。
   不得再出现 schema mount、stderr pipe 导致子进程退出的错误。
5. 全新安装的浏览器功能应默认开启（用户曾明确关闭时仍保持关闭）；查看画面、接管、
   访问本地测试页或当前网络可达网站、输入、交还、
   刷新重连；同一个全屏按钮进入/退出，不依赖 Esc。网页不可达不应锁死操作。
   无外网时 Google 搜索失败不能冒充产品失败，也不能冒充已验证 Google 成功。
6. 打开设置页并在普通窗口尺寸和 Windows 缩放下点击右上角关闭按钮；按钮应保持
   40×40 点击区域、不被标题挤压或遮挡，并能一次关闭。
7. 只删除新建的临时 Bot：即使关联电脑离线也能删，界面显示“正在删除”；
   独立电脑不随之销毁，可能继续运行/计费；应明确提醒去设置或服务商管理。
   正在执行/创建电脑/保存凭据等状态仍需安全收尾。
8. 已归档在工具的下一级；插件品牌图标显示，已授权测试 Gmail/飞书连接在升级和刷新后
   保留。飞书原生连接器已补 Windows/Mac 分支，须按平台分别验收；首次连接必须直接使用安装包内置运行时，
   不得临时从 GitHub 下载 CLI/Node；授权仍必须由测试者本人完成，凭据不得打入安装包。
   其他云插件按服务网络要求使用代理；必须测离线首启→开启系统代理→点击重试后恢复连接入口，
   以及已有身份的断网/恢复。软件注册、列表、授权、MCP 同通道，不要求用户重装或清缓存。
   飞书必须实际完成 IM/只读工具和重启恢复，绿色图标不算全链路通过。开发快捷方式经 junction
   启动时仍须走包内同版运行时，不关闭路径安全校验。其他应用的 `expired` 是授权状态，
   `CONNECTED_APPS_NETWORK_UNREACHABLE` 是多种请求异常的统一提示，不能仅凭其名称认定是 VPN。
9. Local VM 是可选外部容器运行时，不承诺安装器自带 Podman/虚拟机镜像。
   未配置时提示真实原因；已配置时抽测，不能把缺组件包装成“所有电脑都可用”。

10. 任务栏、开始菜单、安装器和卸载入口使用产品图标；Windows 打包输入为 `build/icon.ico`，
    运行时为 `electron/resources/app-icon.png`。开发依赖 `electron.exe` 重装后显示原子图标
    不是正式打包图标被改回去；不得为修开发图标改安装身份或正在使用的原生运行时。

详细浏览器隔离复现见 `docs/verification/browser-live.md`；本轮源码/Windows 证据见
`docs/verification/ruijie-release-regressions-2026-09-11.md`，按时间取最新有效记录，不能继承为新安装包结论。

## 6. 交付记录与放行

本地开发快捷方式先使用与安装包相同的编译内容和固定原生资源验效果，数据仍隔离；
详见通用指南“本地开发快捷方式与安装包保持同一构建内容”。不得跳过 desktop-build.json 的
源码/文件树校验，也不得将 Vite 热更新通过当作安装包资源完整。源码变化后先退出开发版再打开快捷方式。

```powershell
$version = node -p 'require("./package.json").version'
$installer = Join-Path $repoRoot "release/RuijieBot-$version-setup.exe"
Get-Item -LiteralPath $installer | Select-Object Name,Length
Get-FileHash -Algorithm SHA256 -LiteralPath $installer
Get-AuthenticodeSignature -LiteralPath $installer | Select-Object Status
git rev-parse HEAD
git status --short
```

交付安装器、对应 blockmap/latest.yml（需要后续自动更新时）、SHA-256、完整 commit、
工具版本、签名状态、验收报告。`--publish never` 不上传资产，本指南不授权发布 Release。
自动更新发布另需同版本资产、feed、size/hash 一致，并确认所有入口指向 WYunS。
不能拿旧安装器改文件名交付，不能把压缩便携包说成 NSIS 安装版。
报告只写“通过/失败/环境阻塞/未执行”；核心启动、数据、工具、安全失败时不放行。
