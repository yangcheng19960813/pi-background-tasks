# AGENTS.md — pi-background-tasks 个人 fork 开发指南

个人定制 fork：https://github.com/yangcheng19960813/pi-background-tasks.git ，分支 `feature/native-subagent`，基于上游 `ismailsaleekh/pi-background-tasks@2.6.9`。当前版本 2.7.1。详细历史与验收记录见 `LOCAL-DEVELOPMENT.md`。

## 定位

Pi 扩展包（不是独立应用）。核心定制：新增 `bg_subagent` / `bg_subagent_result` 原生角色后台工具，角色执行由 `BackgroundTaskRegistry.startManagedTask()` 直接托管，不经 shell/SDK 桥接。上游原有 bg_run/delegate/fusion/attested 功能保持不动。

实际 Pi 宿主：`@earendil-works/pi-coding-agent@1.0.4`（本机 `C:/Users/Administrator/AppData/Local/nvm/v24.18.0/node_modules/...`）。开发 devDependencies 固定 1.0.4，勿升。

## 硬性约束

- `private: true`：禁止发布到 npm registry。分发只走 GitHub tag/Release + `pi install git:...`。
- Pi 宿主包（pi-ai / pi-coding-agent / pi-tui / typebox）只能放 `peerDependencies`（`*` 且 optional），禁止进 `dependencies` 或打包进产物。
- 不放宽 Windows 权限/symlink 安全断言（registry 测试里 known failures 是环境限制，不是待修 bug）。
- 不重复注册 `subagent` / `subagent_inspect`（那是宿主原有扩展的工具）。
- `maintenance/subagent-source/` 是导入原件，`src/core/subagent/vendor/` 是 AST 提取+本地补丁的执行核心。**禁止直接重跑 `maintenance/import-local-subagent.mjs`**（排他写入，会拒绝或覆盖补丁）。升级执行核心：导入到新目录 → 逐项比较迁移补丁 → 重跑真实 SDK 测试。
- 提交信息用中文 Conventional Commits。

## 双产物体系

| 目录 | 生成命令 | 内容 | 入库 |
|---|---|---|---|
| `dist/` | `npm run build:runtime` | 带 source map 的开发构建 | 是（上游惯例） |
| `runtime/` | `npm run build:package` | 无 map 发布产物（71 文件） | 是（Pi git 安装必需） |

`prepare`（`scripts/prepare-package.mjs`）幂等：包内装了 TypeScript 就重建 runtime，没有就校验已提交的 runtime 可用。原因：Pi 安装 git 包用 `npm install --omit=dev`，无 devDependencies、无法编译。**改了 src 必须重建并提交 runtime/**，否则发布出去的是旧产物。

## 测试

```sh
npm run test:native-subagent        # 11 项真实 Pi SDK 回归（真实子进程，~45s）
npm run test:git-install            # npm Git 安装端到端 + 安装包加载后 11 项 SDK（~70s）
npm run test:extension-deployment   # 7 项 deploy-extension 脚本检查
npm run test:unit                   # registry 58 项（tsx）
```

已知失败，不要试图"修好"：
- `npm run typecheck`：68 条上游测试接口诊断（旧 Context/ExtensionContext 迁移），生产源码 0 诊断。
- 上游 `docs:verify` / `payload:check` / `test:pnpm-pack`：针对上游 npm 公发口径，个人 runtime/ 打包必失败，已从发布链路移除。

## 发布与安装（升级流程）

1. 改版本三处：`package.json` + `package-lock.json`（`npm version <v> --no-git-tag-version`）+ `README.md` facts 表 Version 行。
2. `npm run build:package`，把 `runtime/` 与源码一起提交。
3. `git tag v<版本>` → push 分支和 tag。Actions（`.github/workflows/release.yml`）自动构建并创建 Release、附 npm tgz。
4. 安装/升级：`node <pi-cli>/dist/bundle/cli.js install "git:github.com/yangcheng19960813/pi-background-tasks@v<版本>"`（写入 `~/.pi/agent/settings.json` packages）。
5. 当前激活方式就是 git 包；`agent/extensions/pi-background-tasks/` 目录部署已废弃（快照备份在外层 `.pi/tasks/extension-deployment/`）。两者不可同时加载。

发布坑（已修，勿回退）：
- npm 10 在 `pack --ignore-scripts` 下仍执行 prepare，stdout 混入构建日志 → `check-personal-package.mjs` 截取 JSON 清单并用 `PI_PREPACK_NESTED` 防递归。
- CI 用 Node 24（与本机一致）。

## 改代码的常规路径

改 `src/` → `npm run build:runtime`（dist）+ `npm run build:package`（runtime）→ 跑 `test:native-subagent` → 提交（dist+runtime+src 同步入库）→ 按需发布。

- 注册表/生命周期核心：`src/core/registry.ts`、`src/core/common.ts`
- 后台工具入口：`src/subagent-extension.ts`、`src/extension.ts`
- 执行核心（补丁区，谨慎）：`src/core/subagent/vendor/executor.js`
- 子进程 CLI 解析走 `getPackageDir()`，勿改回 `process.argv[1]`
