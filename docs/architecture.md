# Architecture

Relay is a local control plane shared by three isolated hosts. Browser code never receives direct filesystem access, and the editor extension does not parse AI output.

## Runtime topology

```mermaid
flowchart TB
    subgraph Browser[Browser process]
        Conversation[AI conversation DOM]
        Agent[Conversation agent]
        Worker[MV3 transport worker]
        Popup[Session controls]
        Conversation --> Agent --> Worker
        Popup --> Worker
    end

    subgraph Runtime[Local Rust runtime · loopback only]
        Bridge[Authenticated WebSocket bridge]
        Router[Workspace + session router]
        Policy[Access policy]
        Journal[Execution journal]
        MCP[Workspace MCP server]
        Bridge --> Router --> Policy --> Journal --> MCP
    end

    subgraph Editor[Editor extension host]
        Companion[VS Code-compatible companion]
        Health[Control Center]
        Companion --> Health
    end

    Worker <-->|Token + protocol 3| Bridge
    Companion -->|Roots + heartbeat| Bridge
    MCP --> Workspace[(Bound workspace)]
```

## One action, end to end

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant AI as Web AI
    participant Browser as Browser companion
    participant Bridge as Rust control plane
    participant MCP as Workspace MCP
    participant Project as Selected workspace

    User->>AI: Ordinary coding request
    AI-->>Browser: One relay-action frame
    Browser->>Browser: Validate tool + input
    Browser->>Bridge: capability.invoke + session + action ID
    Bridge->>Bridge: Validate target and access policy

    alt Observe denies mutation
        Bridge-->>Browser: PERMISSION_DENIED
    else Supervised high-risk action
        Bridge-->>Browser: APPROVAL_REQUIRED
        User->>Browser: Approve exact action once
        Browser->>Bridge: session.approve + same action ID
    end

    Bridge->>Bridge: Resolve prior receipt or start once
    Bridge->>MCP: tools/call
    MCP->>Project: Read, edit, search or run
    Project-->>MCP: Local result
    MCP-->>Bridge: Structured outcome
    Bridge-->>Browser: Status + duration + error code/result
    Browser-->>AI: Human-readable relay-receipt
    AI-->>User: Progress or final answer
```

## Component ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| Browser companion | Provider adapters, action parsing, session UI, visible receipts | Filesystem or process execution |
| Editor companion | Trusted root registration, runtime startup, health and activity | AI conversation parsing |
| Rust control plane | Authentication, immutable bindings, policy, deduplication, routing | Provider-specific DOM behavior |
| Workspace MCP | 25 bounded file, project, process, VCS and task capabilities | Browser/editor lifecycle |

## System invariants

- One conversation binds to one selected workspace for the lifetime of its session.
- Only an authenticated editor connection can register workspace roots.
- Tool names must come from the current session capability catalog.
- The same action identity cannot execute twice with different input.
- Uncertain destructive actions are never replayed automatically.
- Closing or changing the owning workspace invalidates its sessions.
- Observe is read-only; Supervised gates high-risk actions; confirmed Autonomous has full local access for that conversation.

See [protocol](protocol.md), [security](security.md), and [agent workflow](agent-workflow.md).
