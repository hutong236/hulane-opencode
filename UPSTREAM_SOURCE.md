# 上游源码声明

- Repository: https://github.com/hutong236/hutong-zcode-marketplace
- Folder: `hulane/` and `test/`
- Source commit (main at copy time): `465ed625630d69b48934d7db07bec392e215c987`
- Hulane plugin version: 3.10.0
- License: MIT; `hulane/scripts/lib/discipline.mjs` retains its attributed upstream ECC MIT notice.

本仓库独立维护；这里仅迁移源文件和测试，后续修改不自动同步旧 Marketplace。迁移时保留原 `hulane/` 相对结构，便于先运行行为回归测试，再逐步抽取 core。

本仓库没有将旧 ZCode Hook JSON 作为 OpenCode Hook 安装；新适配层位于 `opencode/`。
