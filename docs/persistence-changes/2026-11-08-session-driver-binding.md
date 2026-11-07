---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-session-driver-binding

English | [中文](2026-11-08-session-driver-binding.zh.md)

## Summary

A Session driver binding stores its external provider and, after creation, the remote conversation id.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing Sessions have no binding. The new required event discriminator lets older readers refuse an external conversation instead of continuing it as a native model call.

<a id="verification"></a>
## Verification

Web Host integration exercised a Codex model change and resumed the same external conversation after replacing the Host.

<a id="dev-note"></a>
## Dev Note

None.
