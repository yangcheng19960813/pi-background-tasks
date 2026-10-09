# AGENTS.md — pi-background-tasks 个人 fork 开发指南

个人定制 fork：https://github.com/yangcheng19960813/pi-background-tasks.git ，分支 `feature/native-subagent`，基于上游 `ismailsaleekh/pi-background-tasks@2.6.9`。当前版本 2.7.2。详细历史与验收记录见 `LOCAL-DEVELOPMENT.md`。

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
| `runtime/` | `npm run build:package` | 无 map 发布运行闭包 | 是（Pi git 安装必需） |

`prepare`（`scripts/prepare-package.mjs`）幂等：包内装了 TypeScript 就重建 runtime，没有就校验已提交的 runtime 可用。原因：Pi 安装 git 包用 `npm install --omit=dev`，无 devDependencies、无法编译。**改了 src 必须重建并提交 runtime/**，否则发布出去的是旧产物。

## 测试

```sh
npm run test:native-subagent        # 19 项真实 Pi SDK 回归（含 MCP/扩展调用，真实子进程）
npm run test:git-install            # npm Git 安装端到端 + 安装包加载后的完整原生 SDK 回归
npm run test:extension-deployment   # 7 项 deploy-extension 脚本检查
npm run test:unit                   # registry 58 项（tsx）
```

### 子代理的 MCP / 扩展工具

- 角色 `tools` 由原执行器传给子 Pi 的 `--tools`；子进程自行加载个人配置中的扩展与 MCP，不会把父会话的临时工具注册自动复制过去。
- 普通扩展工具要列入角色 `tools`。直接调用 MCP 要列工具名或 `mcp__<server>__*`；延迟发现要列 `tool_search`，默认 codemode 路径要列 `codemode`。
- Pi 1.0.4 的 `--tools read` 不能理解为“清除了所有 MCP 注册”。MCP 的直接声明、间接可调用性和 `mcp__` 过滤规则不同；不要用 read-only 角色描述代替实际权限限制。
- `tests/sdk/subagent-native-sdk.test.mjs` 的四项“工具冒烟”检查真实子 Pi 的 direct MCP + 普通扩展、deferred MCP 搜索后调用、codemode 嵌套 MCP，以及未选中的扩展 / 被 MCP 白名单过滤工具拒绝执行。
- 冒烟只脚本化模型的工具选择，MCP stdio 服务、协议连接、工具执行、扩展 tool_call/tool_result 事件与 transcript 均真实运行。它证明调用链可用，不证明外部模型会自主选择工具，也不代表个人 CodeGraph 等服务已逐一验收。

### 执行预算

- 包内 `bg_subagent` 的 scout 使用统一 `SCOUT_MAX_TOOL_CALLS = 50`：普通和快速任务均最多 50 次模型工具调用；超过上限终止工作流。不恢复旧的普通 20 次 / 快速 10 次配额。
- scout 仍按每个子进程限时：快速任务默认 3 分钟，普通任务默认 8 分钟；`PI_SUBAGENT_SCOUT_TIMEOUT_MS` 的 50 ms–30 分钟覆盖范围不变。
- 外层 registry 超时、主动取消、子孙进程清理、reload/shutdown 与结果持久化保持原逻辑。其他角色限时及 bg_delegate/Fusion 的独立预算不在这次修改范围。

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
