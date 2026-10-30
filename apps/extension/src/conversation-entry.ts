import { WebConversationSurface } from "./adapters/conversation-surface";
import { profileFor } from "./adapters/site-profiles";
import { ConversationRun } from "./domain/run-coordinator";
import type { ActionRequest, ActionResult, Capability, ChatSurface, RunSnapshot, WorkspaceTarget } from "./domain/contracts";
import { ActivityView } from "./presentation/activity-view";

const profile = profileFor(location.hostname);
const agentHost = globalThis as typeof globalThis & { relayConversationAttached?: boolean };
if (profile && !agentHost.relayConversationAttached) {
  agentHost.relayConversationAttached = true;
  const view = new ActivityView();
  const surface = new WebConversationSurface(profile);
  let target: WorkspaceTarget | undefined;
  let access: "workspace" | "full" = "workspace";
  let route = surface.conversation();
  let publishing = Promise.resolve();
  let runId = "";
  const api = async (method: string, fields: Record<string, unknown> = {}, identity = runId) => {
    const reply = await chrome.runtime.sendMessage({ method, runId: identity, ...fields }) as Record<string, unknown>;
    if (!reply?.ok) throw Object.assign(new Error(String(reply?.error || "Relay did not respond.")), { kind: reply?.kind });
    return reply;
  };
  const wrapped: ChatSurface = {
    name: surface.name,
    conversation: () => surface.conversation(), reply: () => surface.reply(), busy: () => surface.busy(),
    submit: async (text, signal) => {
      const identity = runId;
      const before = surface.conversation();
      await surface.submit(text, signal);
      if (text.startsWith("<relay-context>") && /^\/(?:new|app|chat)?\/?$/.test(new URL(before).pathname)) {
        for (let i = 0; i < 50 && surface.conversation() === before; i++) {
          signal.throwIfAborted();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (surface.conversation() !== before) {
          signal.throwIfAborted();
          await api("run.adopt", {}, identity);
          route = surface.conversation();
          run.adoptConversation(route);
        }
      }
    },
  };
  const run = new ConversationRun(wrapped, {
    catalog: async () => (await api("run.catalog")).capabilities as Capability[],
    execute: async (turn: string, action: ActionRequest): Promise<ActionResult> => {
      try { return await chrome.runtime.sendMessage({ method: "run.execute", turn, action, runId }) as ActionResult; }
      catch (error) { return { ok: false, kind: "disconnected", error: String(error) }; }
    },
    publish: state => {
      const identity = runId;
      publishing = publishing.catch(() => {}).then(() => api("run.update", { state }, identity)).then(() => {}).catch(error => { if (state.active && identity === runId) console.warn("[Relay state]", error); });
      if (state.error) console.error("[Relay run]", state.error);
    },
    present: (turn, action, result) => view.display(turn, action, result),
    target: () => target ? `${target.editor.name}: ${target.path}` : "selected workspace",
    access: () => access,
    now: () => Date.now(),
  });

  chrome.runtime.onMessage.addListener((message: { method?: string; target?: WorkspaceTarget; runId?: string; access?: string }, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message.method === "conversation.inspect") { respond({ ok: true, protocol: 3 }); return false; }
    if (message.method === "conversation.begin") {
      target = message.target;
      access = message.access === "full" ? "full" : "workspace";
      runId = message.runId || "";
      route = surface.conversation();
      void run.begin().then(() => respond({ ok: run.snapshot().active, error: run.snapshot().error }));
      return true;
    }
    if (message.method === "conversation.stop") { if (message.runId === runId) run.stop(); respond({ ok: true }); }
    return false;
  });

  document.addEventListener("keydown", event => {
    if (event.isTrusted && event.key === "Enter" && !event.shiftKey && (event.target as HTMLElement)?.closest(profile.input)) run.expectReply();
  }, true);
  document.addEventListener("click", event => {
    if (event.isTrusted && (event.target as HTMLElement)?.closest(profile.send)) run.expectReply();
  }, true);

  let adapting = false;
  const tick = async () => {
    if (adapting) return;
    adapting = true;
    try {
      if (surface.conversation() !== route && run.snapshot().phase !== "preparing") {
        run.stop();
        await api("run.leave").catch(() => {});
        route = surface.conversation();
      }
      const latest = surface.reply();
      if (run.snapshot().active && latest && latest.id !== run.snapshot().lastTurn) view.pending(latest);
      await run.observe(!document.hidden);
      view.maskInternalMessages(profile.user);
    } finally { adapting = false; }
  };
  setInterval(() => { void tick().catch(error => console.error("[Relay]", error)); }, 600);
  document.addEventListener("visibilitychange", () => { void tick(); });
  async function recover(attempt = 0): Promise<void> {
    if (run.snapshot().active) return;
    try {
      const saved = await api("run.status");
      if (run.snapshot().active) return;
      const state = saved.state as RunSnapshot | undefined;
      if (state?.active) { target = saved.target as WorkspaceTarget; access = saved.access === "full" ? "full" : "workspace"; runId = String(saved.runId); await run.restore(state); }
    } catch (error) {
      if (attempt < 5) setTimeout(() => { void recover(attempt + 1); }, Math.min(5000, 500 * 2 ** attempt));
      else console.warn("[Relay recovery]", error);
    }
  }
  void recover();
  const restoreCards = () => { view.historical(surface.history()); view.maskInternalMessages(profile.user); };
  setTimeout(restoreCards, 1000);
  let scrollTimer: ReturnType<typeof setTimeout>;
  document.addEventListener("scroll", () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(restoreCards, 400); }, true);
}
