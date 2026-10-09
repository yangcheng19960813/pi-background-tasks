# 本地定制开发：原生角色后台任务

开发源：https://github.com/yangcheng19960813/pi-background-tasks.git

本地分支：`feature/native-subagent`。未经用户要求，不提交、不推送、不发布。

## 目标

把 subagent 的角色发现、执行预算、单任务/并行/chain、进度和 transcript 功能整合到包内；角色执行作为 `BackgroundTaskRegistry.startManagedTask()` 管理的原生工作流，不经过 EventBus shell 命令 + SDK 子会话桥接。

- 主代理只传角色名和任务；角色模型、thinking、工具、系统提示由执行器加载。
- 保留当前独立的阻塞式 subagent，不重复注册 `subagent` / `subagent_inspect`。
- 新增 `bg_subagent` 和 `bg_subagent_result`，使用包原有的状态、日志、取消、终态通知。
- 主会话保留 off/blocking/nonblocking 三态；子 agent 固定 blocking，拒绝后台派发。
- 项目角色先在父 UI 确认；无 UI 必须显式授权，不能静默跳过。
- 启动确认与工作流启动分开；任务进入 registry 且初始元数据落盘后才开始角色执行。
- 输出、原生结果、transcript 先落盘；进程清理完成后才发布终态。
- 取消、超时、重载、退出必须清理整个角色进程树；压缩不得清空正在执行的任务。
- 保留 EventBus v1，继续兼容现有 task-timer / 输入框上边框 Working。

## 环境差异

实际 Pi 宿主是 `1.0.4`，上游 2.6.9 的开发/peer 配置仍是 `0.84.x`。先验证并处理宿主兼容性，不把 SDK 初始化/伪造模型消息作为执行方案。

## 迁移状态

- fork 已克隆到本项目 `project/pi-background-tasks/`。
- 旧 SDK 桥接实现已从自动加载目录移至 `../legacy-sdk-bridge/`，保留为历史诊断材料，不再作为生产方案。
- npm 安装版已由 Pi 官方 `remove` 命令卸载；曾短期加载开发包进行测试，现已切换为独立 extensions 运行快照，不再通过配置引用开发仓库。
- 当前安装配置迁移备份：外层项目 `.pi/tasks/fork-migration-backup/`。

## 验收

1. 实际 Pi 子进程 + 离线 provider 验证角色模型、thinking、白名单和系统提示。
2. 单任务、并行、chain previous、未知角色、失败必须保留原生语义。
3. 启动后立即返回任务 ID；取消和超时不残留子孙进程。
4. 真实 SDK compaction 与真实 reload 生命周期验证；模拟事件不得代替真实压缩。
5. 终态通知只在原生结果持久化和清理完成后发布；结果按拥有者会话隔离。
6. 保留原文件/角色和用户其他配置；当前 Windows 平台安全断言不放宽。
7. 本地 build/typecheck 与定向回归通过后再加载；全量上游检查单独报告结果及已有失败。


## 当前验证记录

- `npm run build:runtime`：生产源码严格编译通过；执行核心 JS 一并复制到 `dist/src/core/subagent/vendor/`。
- `PI_NATIVE_DEPLOYMENT_DIR=<运行快照> node --test tests/sdk/subagent-native-sdk.test.mjs`：11/11 一起通过；从临时个人 extensions 目录自动发现，不设置后台包 packages 或显式后台入口；默认功能、真实 Pi 1.0.4 子进程及离线 provider，不是模拟子 agent 执行。
- 验证覆盖：单任务立即返回；角色模型/thinking/白名单/提示；并行与 chain previous；未知角色失败；取消、reload、shutdown 清理真实 Windows 子孙进程；真实 `session.compact()`；headless 项目角色授权；子环境拦截；结果的会话隔离。
- 修复：退出时等待终态后的通知元数据写入完成；原生执行错误不再覆盖 registry 的 shutdown/timeout 原因。
- `tests/unit/registry.test.ts`：58/58。累积输出上限测试原先对 Windows 假 PID 调用了真实 taskkill，已补 Windows 树终止测试替身，保留所有输出上限、终态与清理断言。
- 外层计时器/编辑器定向回归：15/15，引用已改为当前 fork 的构建产物。
- 保护检查：13 个基线文件中 12 个字节不变；唯一变化为已授权移除 settings 的 npm 后台包配置，其他配置保持不变。

尚未验收的范围：

- 全量 `npm run typecheck` 仍有 68 条上游测试接口迁移诊断，生产源码无诊断；不能报告全量测试通过。
- 外层三态测试已知 Windows 权限与 symlink 断言不兼容仍保留，未降低安全要求。
- POSIX 角色进程组清理已补根进程提前退出时的强杀，但本机是 Windows，尚无真实 POSIX 进程树验收。
- 启动确认/极快终态交付顺序、进度落盘失败、admission 取消及结果文件防替换仍需专门的故障注入验收。
- 磁盘部署完成不表示正在运行的主会话已重载；Herdr 视觉确认及用户原始压缩故障复现仍待用户现场验证，不等同于 SDK 压缩回归。
- 不提交、不推送、不发布，原本地角色与阻塞式 subagent 保持不变。

## 导入核心的维护方式

`maintenance/subagent-source/` 保存本次导入的原始三份源码；`src/core/subagent/vendor/` 是 AST 提取的执行专用代码，后续已加入 CLI 路径解析、子环境、取消清理等本地补丁。

`maintenance/import-local-subagent.mjs` 使用排他写入，不可直接重跑覆盖归档或补丁。升级原执行器时应导入到新目录，比较源码与生成结果后逐项迁移补丁，再重跑真实 SDK 测试；不初始化原扩展去捕获 execute，也不恢复旧 SDK 桥接。


## npm 从 GitHub 安装（个人安装链路）

当前只整理并验证本地安装链路，未提交、推送或切换现有部署。下面的远程命令要等这些改动进入对应 GitHub 分支后才能使用，不能把当前远程旧版本当成本地已验收版本。

```sh
npm install github:yangcheng19960813/pi-background-tasks#feature/native-subagent --omit=dev
```

应在一个专用的个人 npm 安装目录执行，不在源码仓库中把包安装成自己的依赖。npm Git 安装会先在临时 checkout 安装构建依赖并执行 prepare，然后只安装打包后的运行产物；构建临时依赖不等于向消费目录复制 SDK。

- `npm run build:runtime`：仍输出带源码映射的开发 `dist/`，不改现有开发调试方式。
- `npm run build:package`：单独输出无源码映射的 `runtime/`，不覆盖开发 dist。
- `prepare`：执行个人安装构建；`prepack`：构建并检查真实 npm payload，不沿用上游公开发布的 docs gate。上游检查仍保留为独立命令，已知测试失败未放宽。
- 打包白名单只包括 runtime、使用说明和许可证；不打包 src、tests、maintenance、dist、scripts、node_modules 或本机部署元数据。
- Pi manifest 指向 runtime 的两个父入口；子入口、延迟导入闭包、原生执行器及 evidence 仍完整保留。
- Pi 宿主 peer 标记为 `*` 且 optional，普通 npm Git 安装不自动引入物理 SDK，加载时使用宿主映射；生产依赖仍只有 Turndown 及其传递依赖。
- `private: true` 阻止 npm registry 发布；并不会让现有 GitHub fork 自动变成私有。只有仓库权限控制能限制 GitHub 可见性。
- 原有许可证和来源说明保留；导入执行核心的独立再分发许可仍未核验，不因此宣称可以公开发布。

### 在 Pi 中启用安装包

npm install 只负责安装文件，不自动启用 Pi 扩展。安装完成后，由用户显式执行：

```sh
pi install <个人npm安装目录>/node_modules/pi-background-tasks
```

此处引用的是 npm 安装后的纯运行包，不是 project 开发源码。正式切换必须先确认包加载正常，再备份并把现有 `agent/extensions/pi-background-tasks/` 移出自动发现目录，避免两份同时加载；切换结束才执行 reload。本次没有执行这些切换步骤。

npm 11.16 的 allowScripts 提示目前是审查警告，未来版本可能阻止未审批脚本。应审查后只审批 `pi-background-tasks` 的 prepare，不使用 approve-scripts --all，也不使用 ignore-scripts 跳过必需构建。本次保留该提示，未修改全局或生产安装的审批策略。

### 验证命令与范围

```sh
npm run test:git-install
npm pack
```

- 测试将开发工作树复制进一个独立临时 Git 仓库，仅在该测试仓库创建 fixture commit，不触碰开发仓库历史或暂存区。
- 真实 npm Git install 已执行 prepare，安装仅产生三个生产包，无 map、源码、测试、TypeScript 或宿主 SDK。
- 从实际安装后的包通过 Pi manifest 加载，完整 11 项原生 SDK 回归通过，包含真实子 Pi、角色配置、取消/超时、压缩、重载及会话隔离。
- 该测试验证本地 Git transport 和 npm 的构建/打包机制，未伪称 GitHub 远程认证、分支推送或在线安装已验收。

## extensions 部署（当前启用方式）

- 开发仓库：`C:/Users/Administrator/.pi/project/pi-background-tasks/`，保留 Git 源码和测试。
- 运行目录：`C:/Users/Administrator/.pi/agent/extensions/pi-background-tasks/`。
- `index.ts` 依次初始化 attribution 和 background-tasks；只引用本目录 `dist/`，没有跳转到开发仓库。
- 复制完整运行代码，包括子进程入口、延迟导入模块、原生执行器及 hook-contract evidence；部署时过滤所有 `.map` 文件，并移除文件末尾对应的 sourceMappingURL。开发仓库的源码映射保留。
- 仅复制生产依赖 `turndown@7.2.4`、`@mixmark-io/domino@2.2.0`，保留其许可证；不复制开发 Pi SDK、TypeScript 或项目 node_modules 全树。Pi 宿主库继续由官方扩展加载器解析。
- 运行目录 manifest 不含 `pi.extensions`，避免在目录入口之外重复注册；原始阻塞式 subagent 与角色文件不变。
- `agent/settings.json` 已通过官方 `remove` 删除 `..\\project\\pi-background-tasks`，其余设置与切换前快照逐项相同。普通新会话及 `/reload` 使用目录自动发现，无须 `-e` 或 packages 引用。

### 重建与部署

在开发仓库执行：

```sh
npm run deploy:extension -- C:/Users/Administrator/.pi/agent/extensions/pi-background-tasks
```

该命令先构建，再生成独立运行快照。先在自动加载目录之外暂存，检查普通文件及依赖闭包，完成后才切换目录；Windows 文件占用错误采用有上限的重试，不忽略错误、不修改 ACL。发现目标为符号链接、未受管理目录或存在本地文件改动时拒绝覆盖。部署脚本不改 settings，不执行 reload、提交或推送。

升级前建议先部署到一个临时 `agent/extensions/pi-background-tasks` 目录，再验证目录自动发现：

```sh
npm run deploy:extension -- <临时目录>/agent/extensions/pi-background-tasks
PI_NATIVE_DEPLOYMENT_DIR=<临时目录>/agent/extensions/pi-background-tasks node --test tests/sdk/subagent-native-sdk.test.mjs
```

上面的环境变量写法适用于 Bash；PowerShell 使用 `$env:PI_NATIVE_DEPLOYMENT_DIR='...'` 后执行 Node。

### 备份与回滚

- 每次升级保留旧目录在 agent 目录的上级 `.pi/tasks/extension-deployment/backup-<uuid>`，位于自动加载目录之外。
- `deployment.json` 记录全部文件 SHA-256、依赖版本及构建来源；来源路径仅用于溯源，不参与运行时加载。
- 切换目录失败时恢复旧目录；含本地改动时停止，不能为部署而删除或覆盖这些改动。
- 本次配置备份：外层 `.pi/tasks/extension-deployment/cutover-19ddda63-d3e4-426c-9da2-540af8e0e176/agent-settings.before.json`。
- 回滚时先停止正在运行的任务，把新运行目录移出 extensions，恢复对应旧目录；如需退回此前开发包加载方式，再恢复配置备份中的那一个本地包声明。不要同时保留两种加载方式，也不要覆盖用户后续其他设置。

### 本次验收

- 独立快照完整 SDK 测试此前 11/11；去掉源码映射后，默认包自动加载及真实原生任务执行单项重跑通过，生产目录全部文件哈希与该无 map 测试快照一致。
- 实际个人配置的官方 SDK 资源加载器自动发现 `agent/extensions/pi-background-tasks/index.ts`，加载错误为 0；`bg_subagent`、`bg_subagent_result`、原有 `subagent`、`subagent_inspect` 均仅注册一次，无开发仓库入口。
- 12 份受保护的原扩展、角色和 auth/MCP 文件 SHA-256 不变；正式运行目录 1102 个文件逐一验证完整性。
- 部署脚本测试 7/7：源码映射过滤与开发映射保留、依赖闭包、实际 Turndown 调用、重复部署备份、本地改动保护、未管理目录保护、符号链接和路径拒绝。
- 外层计时器/编辑器回归 15/15；注册表定向回归本次重跑 58/58。
- Herdr 现场视觉、原始压缩症状、全量上游接口兼容、故障注入和 POSIX 进程树验收仍按未完成项记录，不能据此宣称全部功能验收通过。

### 历史开发包激活（已撤销）

曾使用官方 install 把 `..\\project\\pi-background-tasks` 加入个人 packages，启用前备份为外层 `.pi/tasks/native-package-activation-1791466217218/agent-settings.before.json`。该声明现已删除，不是当前生产加载方式。
