# Agent workflow

Today Relay performs this verified loop:

```text
bind workspace → publish capabilities → observe reply → validate one action
→ execute once → return receipt → wait for the next reply
```

The browser coordinator prevents concurrent execution, ignores old turns, aborts late results after stop/restart, and stops after three consecutive failures. Action receipts contain identity, final status, duration, output or error code.

`task.execute` accepts up to 50 dependency-linked steps. It executes independent reads concurrently, serializes mutations, propagates failures, and returns terminal or partial step receipts. Native task persistence, resume after process restart, and automatic verification remain future work.
