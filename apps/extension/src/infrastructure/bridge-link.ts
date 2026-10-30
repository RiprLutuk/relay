export type BridgeMessage = Record<string, unknown>;
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
  private readonly pending = new Map<number, { resolve: (message: BridgeMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  hello: BridgeMessage = {};
  problem?: string;

  constructor(private readonly notify: (ready: boolean) => void, private readonly factory: (url: string) => WebSocket = url => new WebSocket(url)) {}
  ready(): boolean { return this.connected; }
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
      this.socket.send(JSON.stringify({ type: "authenticate", token: this.token }));
      return;
    }
    this.open();
  }

  open(): void {
    clearTimeout(this.reconnect);
    if (this.disposed || !this.token || this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    const socket = this.factory(typeof relayBridgeEndpoint === "undefined" ? "ws://127.0.0.1:17613" : relayBridgeEndpoint);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "authenticate", token: this.token }));
    socket.onmessage = event => {
      let message: BridgeMessage;
      try { message = JSON.parse(String(event.data)) as BridgeMessage; } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.type === "connected") {
        if (message.protocolVersion !== 3) {
          this.problem = "Update the Relay editor package and browser companion together; this runtime uses an older protocol.";
          socket.close();
          return;
        }
        this.problem = undefined;
        this.hello = message;
        this.connected = true;
        this.failures = 0;
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => { void this.request({ type: "ping" }, 5000).catch(() => socket.close()); }, 15000);
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
      if (!this.disposed) this.reconnect = setTimeout(() => this.open(), Math.min(30000, 500 * 2 ** this.failures++));
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
