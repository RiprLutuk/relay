export type BridgeMessage = Record<string, unknown>;
export type ConnectionPhase = "disconnected" | "connecting" | "handshaking" | "connected" | "ready" | "reconnecting" | "degraded" | "error" | "closed";
export interface ConnectionStatus {
  phase: ConnectionPhase;
  lastHeartbeatAt?: number;
  latencyMs?: number;
  retryAttempt: number;
  error?: string;
}
const connectionTransitions: Record<ConnectionPhase, readonly ConnectionPhase[]> = {
  disconnected: ["connecting", "closed"],
  connecting: ["handshaking", "reconnecting", "error", "closed"],
  handshaking: ["ready", "reconnecting", "error", "closed"],
  connected: ["ready", "degraded", "reconnecting", "closed"],
  ready: ["handshaking", "degraded", "reconnecting", "closed"],
  reconnecting: ["connecting", "handshaking", "error", "closed"],
  degraded: ["ready", "reconnecting", "closed"],
  error: ["reconnecting", "closed"],
  closed: [],
};
export function connectionTransitionAllowed(from: ConnectionPhase, to: ConnectionPhase): boolean {
  return from === to || connectionTransitions[from].includes(to);
}
declare const relayBridgeEndpoint: string;

export class BridgeLink {
  private socket?: WebSocket;
  private token = "";
  private sequence = 0;
  private connected = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private failures = 0;
  private disposed = false;
  private health: ConnectionStatus = { phase: "disconnected", retryAttempt: 0 };
  private readonly pending = new Map<number, { resolve: (message: BridgeMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  hello: BridgeMessage = {};
  problem?: string;

  constructor(private readonly notify: (ready: boolean) => void, private readonly factory: (url: string) => WebSocket = url => new WebSocket(url)) {}
  ready(): boolean { return this.connected; }
  status(): ConnectionStatus { return { ...this.health }; }
  private transition(phase: ConnectionPhase, error?: string): void {
    if (!connectionTransitionAllowed(this.health.phase, phase)) return;
    this.health = { ...this.health, phase, retryAttempt: this.failures, error };
  }
  async ensureReady(): Promise<void> {
    if (this.connected) return;
    if (!this.token || this.disposed) throw new Error("Local bridge is offline or unpaired.");
    this.open();
    for (let attempt = 0; attempt < 40; attempt++) {
      if (this.connected) return;
      if (this.disposed) break;
      await new Promise(resolve => setTimeout(resolve, 125));
    }
    throw new Error(this.problem || "Local bridge is offline. No action was sent.");
  }
  dispose(): void {
    this.disposed = true;
    this.transition("closed");
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnect);
    this.socket?.close();
  }

  pair(token: string): void {
    if (token && !/^[a-f0-9]{64}$/i.test(token)) throw new Error("Pairing token must contain 64 hexadecimal characters.");
    this.token = token;
    this.failures = 0;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.connected = false;
      this.transition("handshaking");
      this.socket.send(JSON.stringify({ type: "authenticate", token: this.token }));
      return;
    }
    this.open();
  }

  open(): void {
    clearTimeout(this.reconnect);
    if (this.disposed || !this.token || this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    this.transition(this.failures ? "reconnecting" : "connecting");
    const socket = this.factory(typeof relayBridgeEndpoint === "undefined" ? "ws://127.0.0.1:17613" : relayBridgeEndpoint);
    this.socket = socket;
    socket.onopen = () => {
      this.transition("handshaking");
      socket.send(JSON.stringify({ type: "authenticate", token: this.token }));
    };
    socket.onmessage = event => {
      let message: BridgeMessage;
      try { message = JSON.parse(String(event.data)) as BridgeMessage; } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.type === "connected") {
        if (message.protocolVersion !== 3) {
          this.problem = "Update the Relay editor package and browser companion together; this runtime uses an older protocol.";
          this.transition("error", this.problem);
          socket.close();
          return;
        }
        this.problem = undefined;
        this.hello = message;
        this.connected = true;
        this.failures = 0;
        this.transition("ready");
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          const started = Date.now();
          void this.request({ type: "ping" }, 5000).then(() => {
            this.health = { ...this.health, phase: "ready", lastHeartbeatAt: Date.now(), latencyMs: Date.now() - started, error: undefined };
          }).catch(error => {
            this.transition("degraded", error instanceof Error ? error.message : String(error));
            socket.close();
          });
        }, 15000);
        this.notify(true);
      }
      const waiting = this.pending.get(Number(message.id));
      if (waiting) { clearTimeout(waiting.timer); this.pending.delete(Number(message.id)); waiting.resolve(message); }
      if (message.error === "unauthorized") { this.connected = false; socket.close(); }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.connected = false;
      clearInterval(this.heartbeat);
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Bridge connection lost. The action outcome may be unknown; Relay will not replay it automatically.")); }
      this.pending.clear();
      this.notify(false);
      if (!this.disposed) {
        this.transition("reconnecting", this.problem);
        const delay = Math.min(30000, 500 * 2 ** this.failures++);
        this.reconnect = setTimeout(() => this.open(), delay * (0.8 + Math.random() * 0.4));
      }
    };
  }

  async request(message: BridgeMessage, timeout = 15000): Promise<BridgeMessage> {
    await this.ensureReady();
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Local bridge is offline. No action was sent.");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Bridge response timed out. The action will not be repeated automatically.")); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ ...message, id, token: this.token })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
}
