import { readFileSync } from "node:fs";
import WebSocket from "ws";

type Descriptor = { editor: { id: string; name: string; version: string }; windowId: string; roots: { uri: string; name: string }[]; trusted: boolean };

export class EditorSession {
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private registered = false;
  private sequence = 0;
  private token = "";
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();
  workspaces: Record<string, unknown>[] = [];
  error = "Waiting for the local bridge";

  constructor(private readonly tokenPath: string, private readonly describe: () => Descriptor, private readonly endpoint = `ws://127.0.0.1:${process.env.RELAY_BRIDGE_PORT || "17613"}`) {}

  ready(): boolean { return this.registered; }
  reachable(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  connect(): void {
    if (this.stopped || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this.reconnect);
    try { this.token = readFileSync(this.tokenPath, "utf8").trim(); }
    catch { this.reconnect = setTimeout(() => this.connect(), 1000); return; }
    const socket = new WebSocket(this.endpoint, { headers: { Authorization: `Bearer ${this.token}` } });
    this.socket = socket;
    socket.on("message", raw => {
      let value: Record<string, unknown>;
      try { value = JSON.parse(raw.toString()); } catch { return; }
      if (value.type === "connected") {
        if (value.protocolVersion !== 3) {
          this.error = "Relay requires bridge protocol 3. Stop the incompatible runtime, then start the bundled runtime.";
          socket.close();
          return;
        }
        void this.register();
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => { void this.request("workspace.heartbeat").catch(() => socket.close()); }, 8000);
      }
      const resolve = this.pending.get(Number(value.id));
      if (resolve) { this.pending.delete(Number(value.id)); resolve(value); }
    });
    socket.on("error", error => { this.error = error.message; socket.close(); });
    socket.on("close", () => {
      this.registered = false;
      this.workspaces = [];
      clearInterval(this.heartbeat);
      for (const resolve of this.pending.values()) resolve({ ok: false, error: "Bridge disconnected" });
      this.pending.clear();
      if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), 1000);
    });
  }

  async register(): Promise<void> {
    try {
      const result = await this.request("workspace.register", this.describe());
      this.registered = result.ok === true;
      this.workspaces = this.registered ? result.workspaces as Record<string, unknown>[] : [];
      this.error = this.registered ? "" : String(result.error || "Workspace registration failed");
    } catch (error) { this.error = String(error); this.registered = false; }
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
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnect);
    this.socket?.close();
  }
}
