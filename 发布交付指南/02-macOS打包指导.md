# 锐捷 Bot：macOS 打包指导

> 2026-09-11：先执行 [通用回归与发布门禁](04-通用回归与发布门禁.md)。
> Mac 本机飞书已补源码入口、双架构运行时准备和签名校验，相关隔离源码回归已有记录。
> Windows 开发版获用户确认不代表 Mac 通过；Mac 签名后运行、真实授权和屏幕录制持久授权仍待验。
> 使用 GitHub Actions 时先跑 `Ruijie pre-package verification (NO INSTALLERS)`，不是 Release。
> 必须确认运行 SHA 含当前修复；该流程不打包、不发布，也不替代飞书/TCC 人工验收。

这是 Bot 的 Mac 指南，不是 Harness 的 universal DMG 指南。
Bot 当前为 **0.1.73**，以 package.json 为准；按源码分别构建 arm64 / x64，
不要照搬 Harness 2.1.6、Yarn 或 `cn.com.ruijie.dsh.desktop` 身份。
先读本目录签名策略，最终交付按 `03-macOS真人验收测试指导.md` 验收。

## 1. 源码与环境

公开仓库 <https://github.com/WYunS/OpenMausBot>，正式交付入口为它自己的 `main`。
从该分支固定完整 SHA；Mac 与 Windows 一致，不使用作者仓库的 main 或旧修复分支替代。
普通 main 推送不自动生成安装器；Release 仅保留手动入口，其上游发布/镜像步骤须另行审查。
可在自己的任意可写路径检出，以下从仓库根目录执行：

```bash
git clone --branch main https://github.com/WYunS/OpenMausBot.git OpenMausBot
cd OpenMausBot
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
git status --short
git rev-parse HEAD
node --version
corepack pnpm --version
node -p 'require("./package.json").version'
xcode-select -p
```

要求原生 macOS、Node 24.x、Corepack 管理的 pnpm 10.33.0、Xcode Command Line Tools。
不要从 Windows 交叉打出 DMG 就声称 Mac 可用。安装 Swift speech helper 需要本机 Apple
工具链，但 Electron、CUA、Chromium、cloudflared 使用锁定预编译文件，不从零编译。
不要覆盖已有开发现场；新打包者优先用独立干净检出，保留可校验下载缓存。

## 2. 发布配置和许可

始终用 `--config electron-builder.ruijie.mjs`，更新源才是 `WYunS/OpenMausBot`。
`pnpm package:mac` 已接入锐捷配置和门禁；不要改用上游 Release 工作流或删除 hook。
不要替换 appId；内部 App 仍叫 OpenMausBot.app，窗口叫锐捷Bot，DMG/ZIP 前缀为 RuijieBot。
安装版服务数据使用当前 macOS 用户主目录的 `~/.ruijiebot`，源码开发版仍使用
`~/.openmausbot`；不要把 Windows 的盘符或用户名写死到 Mac 构建中。
`enterprise/` 是单独许可，构建时会纳入；生产使用/分发许可须由发布负责人核实。

当前代码不会因“有 Harness 许可证”自动获得 Bot Enterprise 许可。不得移除许可证
或绕过 feature gate；如要改为纯 OSS 发行，那是另一次明确的发行配置变更和验收。

## 3. 构建共用资源

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
node --test electron/ruijie-package-config.node-test.mjs
corepack pnpm test:packaged-server
corepack pnpm package:prepare
corepack pnpm build:speech
corepack pnpm build:cua
corepack pnpm build:feishu:mac
```

默认准备两种架构；pnpm 10 从 package.json 的 supportedArchitectures 安装对应原生包。
缺 `@trycua/cua-driver-darwin-*` 时检查包管理器/锁文件，不复制 Windows 的 `.node`。
浏览器使用 Mac 的平台 pin；Windows `0.36.0-omb.2` 不能拷进 Mac。
`afterPack` 必须核对完整资源、架构、manifest 与许可证，不能禁用。
全新安装版 profile 必须默认显示内置浏览器；用户已明确关闭时仍保持关闭。
设置窗口关闭按钮的尺寸与点击区域属于共用 UI 修复，Mac 构建不得换回旧版 `dist`。

变更了 Bot UI/server/companion/updater 就重建这些 JS；不用重编译 Harness。
只有 SHA、锁文件、平台/架构、配置和前序生成物全部可核对时才能复用构建断点。
同一 DMG 的验收脚本修正可续验；产品或依赖变更则是新候选，不能继承旧 DMG 结论。

## 4. 选择准确的签名路线

### A. 已有自己的 Developer ID（正式分发）

发布人员在受保护构建环境中配置自己获授权的 Developer ID；不要复制上游作者证书
或 Team ID。以下命令不会自动完成公证：

```bash
corepack pnpm exec electron-builder --config electron-builder.ruijie.mjs --mac --publish never
```

源码 mac.notarize=false：先验证 `.app` 和全部嵌套代码签名，再由发布人员通过自己的
notarytool Keychain profile 提交 DMG/ZIP，等待 Accepted，staple `.app` 和 DMG。
staple 后按仓库 release.yml 的**相关步骤**重新生成 ZIP、blockmap、latest-mac.yml，
不要执行里面向上游/旧镜像发布的步骤。最终哈希必须在所有字节变化结束后计算。

### B. 无 Developer ID（内部测试候选）

明确使用 ad-hoc，而不是把 identity=null 的完全未签名产物称为已签名：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false corepack pnpm exec electron-builder \
  --config electron-builder.ruijie.mjs --mac --publish never \
  -c.mac.identity=- -c.dmg.sign=false
```

该路线准确状态为 `ad-hoc signed, not notarized`，不是正式公证分发。
必须逐个验签真实 Mach-O、外层 `.app`，并通过普通实体 Mac 的 TCC 验收。
electron-builder 成功退出不证明签名闭包通过。若内嵌 CUA/浏览器缺签或权限循环，
停止放行，记录问题，不把关闭 Gatekeeper/删除 quarantine/重置所有 TCC 当修复。
内部包能否给员工安装由发布负责人决定，本指南不默认授权改变系统安全策略。

### C. 屏幕录制反复授权不能只看“已签名”

屏幕录制属于 TCC；公证/Gatekeeper 通过不等于系统已授予或持续识别该权限。
先记录完整弹窗、macOS 版本、同版/升级、安装路径与实际责任进程，再按
[签名策略第 5.1 节](macOS代码签名与TCC身份策略.md#51-屏幕录制重复授权的定向诊断) 排查。
代码的 embedded CUA 失败后可尝试已有 standalone CuaDriver，两者授权身份不同；
需记录实际模式，不能因机器早已安装并授权 CuaDriver 就算包内 CUA 通过。
同版、同位置已允许后，每次截图/退出重开仍反复请求，或者拒绝后持续弹窗，都阻断交付。
系统版本规定的周期性复核应按弹窗原文单列，不与每次操作的权限循环混为一谈。
Developer ID 需核对签名闭包与稳定 requirement；ad-hoc 的跨版本身份不能视作同等保证。
GitHub Actions 不保存用户持久 TCC 状态，最终必须按真人指南完成重复操作与覆盖升级测试。

## 5. 产物及安装形态检查

按当前配置：`release/mac-arm64/OpenMausBot.app` 和 `release/mac/OpenMausBot.app`，
产物为 `RuijieBot-<版本>-mac-arm64.dmg/.zip`、`RuijieBot-<版本>-mac-x64.dmg/.zip`。
`-mac-` 不可省略，否则 Mac Intel ZIP 会与 Windows x64 ZIP 重名覆盖。
没有 universal 主 App。仅发布 ARM 时也要明确范围，不用 ARM smoke 代替 Intel 验收。

```bash
case "$(node -p process.arch)" in
  arm64) APP_PATH="$REPO_ROOT/release/mac-arm64/OpenMausBot.app" ;;
  x64) APP_PATH="$REPO_ROOT/release/mac/OpenMausBot.app" ;;
  *) echo 'Unsupported test host'; exit 1 ;;
esac
RESOURCES="$APP_PATH/Contents/Resources"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -dv --verbose=4 "$APP_PATH"
codesign -dr - "$APP_PATH"
cat "$RESOURCES/app-update.yml"
node scripts/smoke-browser-bundle.mjs --resources "$RESOURCES"
OMB_SMOKE_DIST="$RESOURCES/server" node scripts/smoke-packaged-server.mjs --browser-bundle "$RESOURCES/browser-engine"
```

核对更新 owner WYunS；检查 ui/index.html、server/index.js、ruijie-computer-proxy.js、
companion/index.js、speech helper、cua-driver/cua-sdk、cloudflared、browser-engine、licenses。
Mac tuantuan-feishu 已接入主进程/预加载桥、arm64/x64 Mach-O 与 tar.gz、私有目录和包内依赖。
`build:feishu:mac` 为两个架构分别生成 `dist-native/feishu-runtime/darwin-<arch>`，
只准备当前架构可用 `node scripts/prepare-feishu-runtime.mjs --current`。
许可清单已有独立 Mac arm64/x64 精确记录，复核见 `connectors/feishu/licenses/MAC_AUDIT.md`；
包含 go-keyring 平台增量通知与两个限定 MPL 例外，不自动继承 Windows 或未来哈希。
许可工程复核不等于运行代码已在 Mac 验收通过；打包仍需原生与签名后证据。
包内 CLI/Node 不可缺失或借用 Homebrew/PATH；签名前验来源哈希，签名后验主 App 闭包和同 Team。
同时复测默认中文回复、浏览器后台恢复及 Harness“继续”上下文；不要只测启动页面。
中文规则存在与真实回复合格分开记录；欢迎语、进度、最终回复分别检查，不能只看最后一句中文。
浏览器额外执行通用指南第 2 节的 MCP 优先和 `--viewer-first` 两种启动顺序：
人工/机器人交替操作不得因 daemon 超时配置不同而重启或断流。arm64/x64 Actions 分别运行，
Windows 的通过不能替代 Mac；最终签名安装版仍须连续 60 秒原流和接管/交还验收。
公开插件服务地址可通过 `RUIJIE_COMPOSIO_BROKER_URL` 烘焙进包，必须与验收记录一致；
禁止把项目 API key、个人安装 token 或 VPN 配置写进元数据。
服务自身要求代理时允许用户使用代理；必须按通用指南验证离线首启、开启代理后点击重试、
连接入口恢复和只读调用，不以重新安装代替恢复，也不要求本轮部署自建服务。
按通用指南补运行时、资源、路径、架构和签名验证；其他功能逐项按 Mac 原生证据验收。

上述只验证 unpacked tree。必须挂载**最终 DMG**，从其中 `.app` 再验签和核对架构；
已公证包还要 `xcrun stapler validate` 与 `spctl --assess --type execute`。
把 DMG 内容安装到获授权测试账户的 Applications，再执行真人指南，不能启动源码替代。
签名后的原生文件哈希会变，不能拿签名前的 vendor 文件哈希判签名包损坏。
Finder/DMG 图标输入为 `build/icon.icns`，运行时 Dock 使用 `electron/resources/app-icon.png`；
两者均应为产品图标。Windows 开发运行时的 Electron 原子图标不属于 Mac 打包输入。

## 6. 交付和不能声称的结论

打包必须保留 `package:prepare` 生成的 desktop-build.json：beforePack 检查当前源码与构建内容，
afterPack 检查实际包内 UI/server，拒绝旧产物。开发预览与安装包共用编译内容/固定依赖，
但数据身份仍独立；Windows 预览不替代 Mac 原生和签名后的验收。

```bash
git rev-parse HEAD
git status --short
shasum -a 256 release/*.dmg release/*.zip
```

交付记录：完整 SHA、Bot 版本、目标架构、Node/pnpm、构建配置、签名类型/Team ID、
公证状态、最终 DMG/ZIP SHA-256、静态审计与真人报告。不得包含私钥、token、账户信息。
需要自动更新时另交 post-staple 的最新 ZIP/blockmap/latest-mac.yml，并复核实际字节。
本轮只准备源码和指南，不创建/上传 Release，也未替打包者完成 Mac 实机验收。

Windows 已验证的浏览器超时、删除、Harness 桥接修复不能冒充 Mac 已通过。
没有兼容 Harness 安装版或测试账号时标“未执行/环境阻塞”，不以空模型列表作为验收完成。
