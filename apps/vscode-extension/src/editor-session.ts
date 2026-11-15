import { readFileSync } from "node:fs";
import WebSocket from "ws";

type Descriptor = { editor: { id: string; name: string; version: string }; windowId: string; roots: { uri: string; name: string }[]; trusted: boolean };
export type EditorConnectionPhase = "disconnected" | "connecting" | "handshaking" | "connected" | "ready" | "reconnecting" | "degraded" | "error" | "closed";
export type EditorConnectionStatus = { phase: EditorConnectionPhase; retryAttempt: number; lastHeartbeatAt?: number; latencyMs?: number; error?: string };

export class EditorSession {
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private registered = false;
  private sequence = 0;
  private token = "";
  private retries = 0;
  private health: EditorConnectionStatus = { phase: "disconnected", retryAttempt: 0 };
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();
  workspaces: Record<string, unknown>[] = [];
  error = "Waiting for the local bridge";

  constructor(private readonly tokenPath: string, private readonly describe: () => Descriptor, private readonly endpoint = `ws://127.0.0.1:${process.env.RELAY_BRIDGE_PORT || "17613"}`) {}

  ready(): boolean { return this.registered; }
  reachable(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  status(): EditorConnectionStatus { return { ...this.health }; }
  private transition(phase: EditorConnectionPhase, error?: string): void {
    this.health = { ...this.health, phase, retryAttempt: this.retries, error };
  }

  connect(): void {
    if (this.stopped || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this.reconnect);
    this.transition(this.retries ? "reconnecting" : "connecting");
    try { this.token = readFileSync(this.tokenPath, "utf8").trim(); }
    catch {
      this.retries++;
      this.transition("reconnecting", "Waiting for the local bridge token");
      this.reconnect = setTimeout(() => this.connect(), 1000);
      return;
    }
    const socket = new WebSocket(this.endpoint, { headers: { Authorization: `Bearer ${this.token}` } });
    this.socket = socket;
    socket.on("open", () => this.transition("handshaking"));
    socket.on("message", raw => {
      let value: Record<string, unknown>;
      try { value = JSON.parse(raw.toString()); } catch { return; }
      if (value.type === "connected") {
        if (value.protocolVersion !== 3) {
          this.error = "Relay requires bridge protocol 3. Stop the incompatible runtime, then start the bundled runtime.";
          socket.close();
          return;
        }
        this.transition("connected");
        void this.register();
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          const started = Date.now();
          void this.request("workspace.heartbeat").then(() => {
            this.health = { ...this.health, phase: this.registered ? "ready" : "connected", lastHeartbeatAt: Date.now(), latencyMs: Date.now() - started, error: undefined };
          }).catch(error => {
            this.transition("degraded", error instanceof Error ? error.message : String(error));
            socket.close();
          });
        }, 8000);
      }
      const resolve = this.pending.get(Number(value.id));
      if (resolve) { this.pending.delete(Number(value.id)); resolve(value); }
    });
    socket.on("error", error => { this.error = error.message; this.transition("error", error.message); socket.close(); });
    socket.on("close", () => {
      this.registered = false;
      this.workspaces = [];
      clearInterval(this.heartbeat);
      for (const resolve of this.pending.values()) resolve({ ok: false, error: "Bridge disconnected" });
      this.pending.clear();
      if (!this.stopped) {
        this.retries++;
        this.transition("reconnecting", this.error);
        const delay = Math.min(30000, 500 * 2 ** Math.min(this.retries, 6));
        this.reconnect = setTimeout(() => this.connect(), delay * (0.8 + Math.random() * 0.4));
      }
    });
  }

  async register(): Promise<void> {
    try {
      const result = await this.request("workspace.register", this.describe());
      this.registered = result.ok === true;
      this.workspaces = this.registered ? result.workspaces as Record<string, unknown>[] : [];
      this.error = this.registered ? "" : String(result.error || "Workspace registration failed");
      if (this.registered) { this.retries = 0; this.transition("ready"); }
      else this.transition("degraded", this.error);
    } catch (error) { this.error = String(error); this.registered = false; this.transition("degraded", this.error); }
  }

  async inspect(): Promise<Record<string, unknown>> {
    if (!this.registered) throw new Error(this.error);
    return this.request("capability.list");
  }

  private async request(type: string, fields: object = {}): Promise<Record<string, unknown>> {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Bridge offline");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error("Bridge did not respond")); }, 5000);
      this.pending.set(id, value => { clearTimeout(timeout); value.ok === false ? reject(new Error(String(value.error))) : resolve(value); });
      this.socket!.send(JSON.stringify({ type, ...fields, id, token: this.token }));
    });
  }

  dispose(): void {
    this.stopped = true;
    this.transition("closed");
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnect);
    this.socket?.close();
  }
}
