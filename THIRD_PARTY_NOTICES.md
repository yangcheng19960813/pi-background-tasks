# Third-party notices

## Anthropic system-prompt sanitization rules

The line-start prefix Anthropic system-prompt sanitization rules in
`src/core/anthropic-attribution.ts` are derived from
[`ravshansbox/pi-anthropic-sps`](https://github.com/ravshansbox/pi-anthropic-sps)
at commit `3a27cb3f8a2ddf62ee6219357c09a24e33e47cfc` (earlier exact-match rules
came from commit `17409b5615f0ec0625776bc5434f92f2c55e3fd0`).

Copyright (c) 2026 Ravshan

Licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.


## 本地 subagent 执行核心来源

本地定制加入 `src/core/subagent/vendor/` 的代码，来自用户授权整合的本地 `agent/extensions/subagent/` 中 `index.ts`、`agents.ts` 和 `transcript-store.ts`。

对应原文保存在 `maintenance/subagent-source/`，AST 提取脚本为 `maintenance/import-local-subagent.mjs`；执行专用版本另含此 fork 的宿主兼容与生命周期补丁。原本地文件不修改，原包的 ISC 版权及上述第三方 MIT 声明继续保留。

本次导入来源尚未核实独立的再分发授权，不能因为包的 ISC 声明就推定导入代码也按 ISC 授权。当前限定为授权的本地开发与验证，发布前须补齐来源版权和许可信息。
