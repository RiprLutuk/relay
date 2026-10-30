export interface WorkspaceTarget {
  id: string;
  name: string;
  path: string;
  windowId: string;
  editor: { id: string; name: string; version?: string };
}

export interface Capability {
  name: string;
  description: string;
  server: string;
  inputSchema: Record<string, unknown>;
}

export interface WorkspaceBinding {
  sessionId: string;
  workspaceId: string;
  bridgeId: string;
  access: "workspace" | "full";
}

export type RunPhase = "idle" | "preparing" | "waiting" | "executing" | "returning" | "paused" | "stopped" | "failed";

export interface ActivityEvent {
  at: number;
  phase: RunPhase;
  title: string;
  detail?: string;
}

export interface ActionRequest {
  tool: string;
  input: Record<string, unknown>;
}

export interface ActionResult {
  ok: boolean;
  text?: string;
  error?: string;
  kind?: string;
}

export interface AssistantTurn {
  id: string;
  text: string;
  element: HTMLElement;
}

export interface ChatSurface {
  readonly name: string;
  conversation(): string;
  reply(): AssistantTurn | null;
  busy(): boolean;
  submit(text: string, signal: AbortSignal): Promise<void>;
}

export interface RunSnapshot {
  conversation: string;
  phase: RunPhase;
  active: boolean;
  lastTurn?: string;
  pendingReply?: boolean;
  error?: string;
}
