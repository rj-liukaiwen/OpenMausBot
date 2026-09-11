# macOS 固定飞书运行时许可工程复核

日期：2026-09-11。范围为以下四个官方制品；不是功能验收、法律认证或可复现构建证明。
用户将两项既有 MPL 例外是否扩展交由实施者决定；本次决定仅扩展到下列两个 Node 哈希，
其余许可限制不变。manifest 的 releaseApproved 仅用于依赖许可门禁，不是应用发布许可。

| 制品 | 归档 SHA-256 | 可执行文件 SHA-256 | 可执行文件字节数 |
|---|---|---|---|
| CLI 1.0.93 darwin-arm64 | eaa09754925c00a6858e91518a49ab8e0a24bd4178e4698a7b185046b8ea24e2 | 9092c3f255b749afdc2a842be5d582511d978424c11326d59af90c0fd5f5c044 | 46646010 |
| CLI 1.0.93 darwin-amd64 | bf37861ce5b5fb10c093ffd8b7305f2a80349280cf32563267c29f81cb864e53 | 8264bb7982df6c4f89ddea5635f7986352d371fb09a33fad5bf3352caa24f9ba | 49616375 |
| Node 24.15.0 darwin-arm64 | 372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4 | 3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32 | 119944608 |
| Node 24.15.0 darwin-x64 | ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b | 2a249a6a7015b0555c3448a77d226c1f3c8f62bd133d89044a2e1518cd16c4b3 | 122278784 |

## 已采集的只读证据

命令 `node scripts/audit-feishu-mac-artifacts.mjs` 退出 0；仅 HTTPS 下载到内存、
解压检查固定归档成员和源码，未执行下载的程序，未安装、签名、授权或构建应用。
来源 URL 锁在 runtime-artifacts.mjs；内容哈希不等同于上游签名认证。

- 四个 Mach-O 均匹配目标 CPU 和上述哈希。链接库只位于 /usr/lib/ 与 /System/Library/。
  CLI 使用 libSystem、libresolv、CoreFoundation、Security；Node 使用 CoreFoundation、
  Security、libc++、libSystem。系统库不随本产品分发，此项不是完整操作系统许可审计。
- 两个 CLI 均为 Go 1.26.5、CGO_ENABLED=0，源码提交
  2aebe8970f0a472dfc864b6ac3d19d080e75041f、vcs.modified=false；42 个 Go 依赖模块，
  41 个模块版本和 Go sum 与已审 components.json 一致，复用其完整通知和 Go 运行时通知。
  不能据此宣称字节级复现编译或全部符号证明。
- 唯一新增模块 github.com/zalando/go-keyring v0.2.8，sum
  h1:6sD/Ucpl7jNq10rM2pgqTs0sZ9V3qMrqfIIy5YPccHs=。上游固定 tag 解析到
  a8cdfe320cc8bc0534c895a648dc9214715a9da5；读取其根 MIT、internal/shellescape/LICENSE
  及源文件归属、keyring_darwin.go 的 Google Apache-2.0 标头。完整条款与归属均保存在
  MAC_CLI_ADDITIONAL_NOTICES.txt；Darwin 通过 /usr/bin/security 使用系统钥匙串。
  Go proxy .info 请求超时，不将它记录为成功；依据二进制 Go buildinfo 与固定上游源码进行复核。
- 两个 CLI 归档的根 LICENSE SHA 为
  c969fc7e3af68e6bf40b0d8dd9c3dcc377eb685a2139535b203b39fdcad739ee；
  两个 Node LICENSE SHA 为
  4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18，均与已审原文一致。
- 同版 Node 源码 deps/amaro/dist/index.js 中的 WASM 为 2504689 字节，SHA
  2c8132e2c965a6a10024bf83dcee287fe15a0cb90f987394d1f9f3d68053a851。
  完整 Base64 编码在两个 Mac Node 二进制均可见；不是只搜版本名。
  因此复用已有 SWC/Rust/生成代码通知及 smartstring 源码链复核。
- NSS 根证书以同版 Node 源码/生成头文件保守完整覆盖，未声称重新执行两种 Mac 的证书枚举。
  两项 MPL 来源、完整条款、随附源码和权利保留由 MAC_SOURCE_AVAILABILITY.md 说明。

## 结论和保留项

以上模块/同版源码级许可材料已补齐；target 记录分别锁定四个制品，不从 Windows 自动继承批准。
许可门禁仍须核对所有 noticeFiles 的实际字节数与 SHA-256；改哈希或新增组件必须重新审查。
没有跳过其他 copyleft 限制，也未修改官方程序源码。

尚未运行 Mac CLI/Node、飞书授权、只读调用、IM、签名后执行或最终安装验收。
GitHub Actions 可以执行原生检查，但不能以 Windows 或 mock 通过替代这些证据。
工程复核不保证全部版权事实，不消除既有 Rust 原始构建与可复现性残余风险。
