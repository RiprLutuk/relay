import { actionReceipt, readActionFrame, sessionContext } from "./action-frame";
import type { ActionRequest, ActionResult, AssistantTurn, Capability, ChatSurface, RunSnapshot } from "./contracts";

export interface RunPorts {
  catalog(): Promise<Capability[]>;
  execute(turn: string, action: ActionRequest): Promise<ActionResult>;
  publish(state: RunSnapshot): void;
  present(turn: AssistantTurn, action: ActionRequest, result?: ActionResult): void;
  target(): string;
  access?(): "workspace" | "full";
  now(): number;
}

export class ConversationRun {
  private abort = new AbortController();
  private current: RunSnapshot;
  private observation = { value: "", since: 0 };
  private occupied = false;
  private failures = 0;
  private awaitingReply = false;
  private revision = 0;
  private capabilities = new Set<string>();

  constructor(private readonly surface: ChatSurface, private readonly ports: RunPorts, private readonly settleMs = 2000) {
    this.current = { conversation: surface.conversation(), phase: "idle", active: false };
  }

  snapshot(): RunSnapshot { return { ...this.current, pendingReply: this.awaitingReply }; }
  expectReply(): void { if (this.current.active) { this.awaitingReply = true; this.ports.publish(this.snapshot()); } }

  private transition(phase: RunSnapshot["phase"], error?: string): void {
    this.current = { ...this.current, phase, error };
    this.ports.publish(this.snapshot());
  }

  async begin(): Promise<void> {
    if (this.current.active) throw new Error("This conversation already has an active run.");
    this.abort = new AbortController();
    const revision = ++this.revision;
    const signal = this.abort.signal;
    this.failures = 0;
    this.observation = { value: "", since: 0 };
    this.current = { conversation: this.surface.conversation(), phase: "preparing", active: true, lastTurn: this.surface.reply()?.id };
    this.awaitingReply = true;
    this.transition("preparing");
    try {
      const catalog = await this.ports.catalog();
      if (signal.aborted || revision !== this.revision) return;
      if (!catalog.length) throw new Error("The selected workspace has no available capabilities.");
      this.capabilities = new Set(catalog.map(capability => capability.name));
      await this.surface.submit(sessionContext(catalog, this.ports.target(), this.ports.access?.()), signal);
      if (!signal.aborted && revision === this.revision) this.transition("waiting");
    } catch (error) { if (revision === this.revision) this.fail(error); }
  }

  async restore(saved: RunSnapshot): Promise<void> {
    if (!saved.active) return;
    const revision = ++this.revision;
    const catalog = await this.ports.catalog();
    if (revision !== this.revision) return;
    this.capabilities = new Set(catalog.map(capability => capability.name));
    this.current = { ...saved, conversation: this.surface.conversation(), phase: "waiting" };
    this.awaitingReply = saved.pendingReply ?? (this.surface.busy() || ["preparing", "executing", "returning"].includes(saved.phase));
    this.transition("waiting");
  }

  adoptConversation(conversation: string): void {
    this.current = { ...this.current, conversation };
    this.ports.publish(this.snapshot());
  }

  stop(): void {
    this.revision++;
    this.abort.abort();
    this.current.active = false;
    this.transition("stopped");
  }

  private fail(error: unknown): void {
    if (this.abort.signal.aborted) return;
    this.current.active = false;
    this.transition("failed", error instanceof Error ? error.message : String(error));
  }

  async observe(visible = true): Promise<void> {
    if (!this.current.active || this.occupied || this.abort.signal.aborted) return;
    if (this.surface.conversation() !== this.current.conversation) return;
    if (!visible) { if (this.current.phase !== "paused") this.transition("paused"); return; }
    if (this.current.phase === "paused") this.transition("waiting");
    const turn = this.surface.reply();
    if (this.surface.busy()) this.awaitingReply = true;
    if (!this.awaitingReply || !turn || turn.id === this.current.lastTurn || this.surface.busy()) {
      this.observation = { value: "", since: this.ports.now() };
      return;
    }
    const value = `${turn.id}\n${turn.text}`;
    if (value !== this.observation.value) {
      this.observation = { value, since: this.ports.now() };
      return;
    }
    if (this.ports.now() - this.observation.since < this.settleMs) return;
    this.occupied = true;
    const revision = this.revision;
    const signal = this.abort.signal;
    this.current.lastTurn = turn.id;
    this.awaitingReply = false;
    try {
      const decoded = readActionFrame(turn.text);
      if (decoded.kind === "answer") { this.transition("waiting"); return; }
      let result: ActionResult;
      if (decoded.kind === "invalid") {
        result = { ok: false, error: decoded.error };
      } else {
        this.transition("executing");
        this.ports.present(turn, decoded.action);
        result = this.capabilities.has(decoded.action.tool)
          ? await this.ports.execute(turn.id, decoded.action)
          : { ok: false, error: "Capability is unavailable. Use an exact name from the supplied catalog." };
        if (signal.aborted || revision !== this.revision) return;
        this.ports.present(turn, decoded.action, result);
      }
      if (signal.aborted || revision !== this.revision) return;
      if (result.kind === "workspaceUnavailable" || result.kind === "disconnected") throw new Error(result.error || "Workspace connection lost.");
      this.failures = result.ok ? 0 : this.failures + 1;
      if (this.failures >= 3) throw new Error("Three actions failed in succession. Review the latest error before resuming.");
      this.transition("returning");
      await this.surface.submit(actionReceipt(decoded.kind === "action" ? decoded.action.tool : "invalid action", result), signal);
      this.awaitingReply = true;
      if (!signal.aborted && revision === this.revision) this.transition("waiting");
    } catch (error) { if (revision === this.revision) this.fail(error); }
    finally { this.occupied = false; }
  }
}
