# Agent Note: SDK 客户端以真正的 Node 解释器启动运行时

Status: implemented

[English](2026-09-01-sdk-client-node-interpreter.md) | 中文

## Problem

HarnessClient 之前用 `process.execPath` 启动运行时子进程，即调用进程的解释器。
因此，在 Bun 下运行的 TUI 客户端（Bun + OpenTUI 渲染界面，并将 harness 作为子进程启动）
会用 Bun 启动 `lib/bin.js`。Bun 1.3.10 的转译器在分析某些 harness 插件源码时
（例如 `llm/llm-pi-ai/src/index.ts`）会以 `Scope mismatch while visiting` 崩溃；
运行时在 spawn 后约 70ms 即退出，尚未完成 JSON-RPC initialize 握手，
TUI 面板显示为无法输入的失效状态。

## Decision

`resolveDshLaunch` 通过 `runtimeCommand()` 解析运行时解释器：
`DSH_RUNTIME_NODE` 可强制指定二进制；否则，Bun 调用方
（`process.execPath` 基名为 `bun`/`bun.exe`）会使用 `npm_node_execPath`，
回退到 `PATH` 上的 `node`；其他调用方继续使用自身的 `process.execPath`。
运行时的契约不变——由 Node（或兼容 Node 的解释器）执行同一套已构建的 `lib`
入口和同一组 profile patch。

## Alternatives considered

**让 TUI 本身运行在 Node 下。** 拒绝：OpenTUI 渲染器与 TUI 的插件栈均以 Bun 构建；
更换宿主解释器是另一项迁移，而不是运行时启动修复。

**锁定或修补 Bun 等待上游修复。** 拒绝：该 panic 是已知的 Bun 编译器 bug，
短期内没有修复；运行时本来就完全不需要 Bun 的转译器。

**在 TUI 中依赖包装脚本。** 拒绝：SDK 客户端负责启动子进程；解释器的选择
应属于发起启动的这一接缝。

## Consequences

即使调用方运行在 Bun 下，运行时也始终以真正的 Node 启动；`DSH_RUNTIME_NODE`
为运维提供了显式覆盖。Python SDK 不受影响（它自行启动运行时）。解释器回退到
`PATH` 上的 `node`，因此 Node 缺失或被遮蔽时表现为常规的 spawn 失败，而不是 Bun 崩溃。