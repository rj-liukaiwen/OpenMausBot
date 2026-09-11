# 锐捷 Bot fork 一键测试发布

适用于 `rj-liukaiwen/OpenMausBot` 的 `main`，当前版本 v0.1.74。

## 所有者确认的测试范围

2026-09-11，所有者明确要求沿用 v0.1.73 的测试发布配置，跳过新版真人验收记录要求。
`electron-builder.testing.mjs` 因此仅检查当前源码和编译结果一致性，不要求生产配置的真人验收凭据。
生产配置 `electron-builder.ruijie.mjs` 的门禁仍保留，不生成伪造的 `passed` 记录。

- Windows x64：未签名 NSIS 和 ZIP。
- Linux x64：DEB 和 AppImage。
- macOS：一个 Universal DMG 和 ZIP，Apple Silicon/Intel 自动化原生检查均需通过。
- Mac 应用沿用 ad-hoc 临时签名，未公证；飞书 CLI/Node 保留已批准的原始字节与原签名，以固定哈希验证，不修改或放宽运行时信任规则。
- 真人飞书/云应用授权、模型语言与搜索、Mac TCC 持久性、真人安装升级：未验收。
- 所有者已确认 Enterprise 公开再分发授权，仓库保持公开，发布到此 fork。
- 安装版服务数据是 `~/.ruijiebot`，开发版仍是 `~/.openmausbot`；应用身份 `com.openmausbot.app` 保持不变。

## 下次操作

1. 在本 fork 的 Actions 选择 **RuijieBot evaluation release**。
2. 点击 **Run workflow**，分支选 `main`，填写新的版本号，例如 `v0.1.75`。
3. `source_ref` 留空，使用所选分支。需要构建其他已审提交时可填该 fork 的分支或完整 SHA。
4. `release_mode` 选择 `draft`（生成草稿）、`prerelease`（公开测试版）或 `artifacts`（仅构建附件）。
5. 所有任务成功后从 Artifacts 下载，或打开对应的 Releases 草稿/测试版。

流程固定同一候选提交构建所有平台，检查包内容、原生程序启动、浏览器与服务端、Linux 安装升级、Mac 完整签名闭包，并校验最终下载文件与更新元数据的摘要。
已有版本不覆盖。中途失败后可修复再用尚未发布的版本号重跑；已存在的发布只能复用完全相同提交和字节的草稿附件。

Windows 浏览器供应包来自独立依赖版本 `browser-engine-v0.36.0-omb.2`，下载 ZIP SHA256 固定为
`2b1640d48881b98d4a97f674b8ec9618fb26abf07097d69ce5735d2022639db7`，解压后仍执行来源和生产二进制哈希检查。
依赖版本不是应用版本，不标为 latest。

本配置提供的是测试候选，不代表新版生产验收全部完成。将来需要正式签名、公证或真人验收时，应恢复相应发布条件后再发布。
