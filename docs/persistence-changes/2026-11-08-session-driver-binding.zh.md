---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-session-driver-binding

[English](2026-11-08-session-driver-binding.md) | 中文

## 概述

会话驱动绑定记录外部提供方，并在线程创建后保存远端对话标识。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-session-driver-binding
baseline: false
changes:
  - root: "event:session/driver-bound"
    previous: null
    after: "aa1f1ada10f6974e2608bd8bcbfab3e4414db8cf647bdde311fa31b41763849f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

原有会话没有绑定。新事件判别字段使旧读取端能拒绝外部对话，避免按原生模型调用继续执行。

<a id="verification"></a>
## 验证

Web Host 集成验证覆盖了切换 Codex 模型以及更换 Host 后恢复同一外部对话。

<a id="dev-note"></a>
## 开发备注

无。
