# macOS 固定运行时：许可适用范围与源码获取

日期：2026-09-11。仅适用于 manifest.json 中单独列出的 Node 24.15.0
darwin-arm64 / darwin-x64 和 lark-cli 1.0.93 darwin-arm64 / darwin-amd64。
Windows 的批准不自动覆盖 Mac；本次依据两种 Mac 官方制品的单独复核记录扩展。

Node 的 NODE_LICENSE.txt 与两种官方归档中的 LICENSE 字节相同；其他 Node、
SWC、Rust、Unicode 补充通知一并保守覆盖同版运行时。此前文档中的 Windows 标题
描述原始审计范围，不表示同一组件在本次 Mac 制品中不受那些许可约束。

本次仅将 smartstring 1.0.1 和 NSS 来源根证书数据的两个限定 MPL 政策例外
扩展至 manifest.json 锁定的两个 Mac Node 可执行文件 SHA-256，其他禁令保持不变。
不批准未来版本、哈希变化或其他 MPL/GPL/AGPL/SSPL 组件。

源码取得方式、固定 URL、哈希、完整权利说明沿用随附 SOURCE_AVAILABILITY.md。
该文档中的 Windows 范围由本补充说明扩展至上述两个固定 Mac 制品。所有引用的
sources/smartstring-1.0.1.crate、sources/node-v24.15.0-certdata.txt、
sources/node-v24.15.0-node_root_certs.h.txt 和 MPL-2.0.txt 必须原样随应用交付。
无需联网、账户或付费即可从应用资源
tuantuan-feishu-runtime/node-24.15.0-darwin-<arch>/licenses/ 获取（arch 为 arm64 或 x64）。
上游 NSS 到头文件的转换及用户按 MPL 使用、修改、分发源码的权利保持不变，
产品其他条款不得限制这些权利。不把相关组件或整个应用重新标为 MIT。

CLI 共用模块继续保留 CLI_THIRD_PARTY_NOTICES.txt 和 UNICODE_NOTICES.txt；
Mac 新增 go-keyring v0.2.8 的 MIT、shellescape 的 MIT 和 Darwin 文件的 Apache-2.0
归属及完整条款见 MAC_CLI_ADDITIONAL_NOTICES.txt，不能只以根 MIT 代替。

官方程序源码未被本产品修改；正式发行可能重新进行 Apple 代码签名，
签名字节变化不改变上述源码取得义务。签名前必须匹配固定哈希，签名后仍需验
同 Team ID 和完整应用签名闭包。工程审计不是法律认证、可复现构建证明或功能验收。
