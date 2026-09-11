# 共享发布接入

Actions → 发布软件。三平台共用候选 SHA，Windows 未签名，Mac Universal 使用现有 fork 的 ad-hoc 测试策略，保留 Feishu 厂商原始字节和精确哈希校验。

Windows vendor 已由原发布任务补充至本仓库的 `browser-engine-v0.36.0-omb.2` 依赖 Release；预检验证地址，Windows 构建继续验证压缩包和可执行文件哈希。

本适配器调用现有测试打包和原生冒烟脚本。原 `private-release.yml`（显示为 RuijieBot evaluation release）继续保留。共享工具库只负责版本固定、任务编排、Artifacts 和 Release；不修改应用身份或数据目录。

签名、真人验收范围以 `发布交付指南/05-fork一键测试发布.md` 的测试配置为准；生产 `electron-builder.ruijie.mjs` 的验收门禁仍保留。生成测试包不代表真人登录、TCC 和升级验收已完成。

v0.1.74 正由原发布入口验证，避免重复发布同版本。共享流程首次完整验证使用新的测试版本或仅运行 check。执行结果以对应 Actions run 为准。
