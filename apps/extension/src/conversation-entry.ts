import { WebConversationSurface } from "./adapters/conversation-surface";
import { profileFor } from "./adapters/site-profiles";
import { ConversationRun } from "./domain/run-coordinator";
import { isProvisionalConversation } from "./domain/conversation-address";
import { isExtensionContextInvalid } from "./domain/extension-lifetime";
import type { ActionRequest, ActionResult, Capability, ChatSurface, RunSnapshot, WorkspaceTarget } from "./domain/contracts";
import { ActivityView } from "./presentation/activity-view";

const profile = profileFor(location.hostname);
const agentHost = globalThis as typeof globalThis & { relayConversationAttached?: boolean };
if (profile && !agentHost.relayConversationAttached) {
  agentHost.relayConversationAttached = true;
  const view = new ActivityView();
  const surface = new WebConversationSurface(profile);
  let target: WorkspaceTarget | undefined;
  let access: "observe" | "supervised" | "autonomous" = "supervised";
  let route = surface.conversation();
  let publishing = Promise.resolve();
  let adoption: Promise<void> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let detached = false;
  let runId = "";
  const detach = () => {
    detached = true;
    if (ticker) clearInterval(ticker);
    agentHost.relayConversationAttached = false;
  };
  const report = (scope: string, error: unknown) => {
    if (isExtensionContextInvalid(error)) { detach(); return; }
    console.error(scope, error);
  };
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
      if (text.startsWith("<relay-context>") && isProvisionalConversation(before)) {
        for (let i = 0; i < 100 && isProvisionalConversation(surface.conversation()); i++) {
          signal.throwIfAborted();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        signal.throwIfAborted();
        if (!isProvisionalConversation(surface.conversation())) await followRoute(surface.conversation(), identity);
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
      publishing = publishing.catch(() => {}).then(() => api("run.update", { state }, identity)).then(() => {}).catch(error => { if (state.active && identity === runId) report("[Relay state]", error); });
      if (state.error) console.error("[Relay run]", state.error);
    },
    present: (turn, action, result) => view.display(turn, action, result),
    target: () => target ? `${target.editor.name}: ${target.path}` : "selected workspace",
    access: () => access,
    now: () => Date.now(),
  });

  async function followRoute(next: string, identity = runId): Promise<void> {
    if (next === route) return;
    if (!adoption) adoption = api("run.adopt", {}, identity).then(() => {
      route = next;
      run.adoptConversation(next);
    }).finally(() => { adoption = undefined; });
    await adoption;
  }

  chrome.runtime.onMessage.addListener((message: { method?: string; target?: WorkspaceTarget; runId?: string; access?: string; turn?: string; action?: ActionRequest; result?: ActionResult }, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message.method === "conversation.inspect") { respond({ ok: true, protocol: 3 }); return false; }
    if (message.method === "conversation.begin") {
      target = message.target;
      access = message.access === "observe" ? "observe" : message.access === "autonomous" ? "autonomous" : "supervised";
      runId = message.runId || "";
      route = surface.conversation();
      void run.begin().then(() => respond({ ok: run.snapshot().active, error: run.snapshot().error }));
      return true;
    }
    if (message.method === "conversation.completeApproval") {
      const turn = surface.reply();
      if (message.runId !== runId || !turn || turn.id !== message.turn || !message.action || !message.result) { respond({ ok: false, error: "The pending action is no longer visible in this conversation." }); return false; }
      void run.completeApproval(turn, message.action, message.result).then(() => respond({ ok: true }));
      return true;
    }
    if (message.method === "conversation.stop") { if (message.runId === runId) run.stop(); respond({ ok: true }); }
    return false;
  });

  document.addEventListener("keydown", event => {
    const element = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
    if (event.isTrusted && event.key === "Enter" && !event.shiftKey && element?.closest(profile.input)) run.expectReply();
  }, true);
  document.addEventListener("click", event => {
    const element = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
    if (event.isTrusted && element?.closest(profile.send)) run.expectReply();
  }, true);

  let adapting = false;
  const tick = async () => {
    if (adapting || detached) return;
    adapting = true;
    try {
      const currentRoute = surface.conversation();
      if (currentRoute !== route) {
        if (run.snapshot().active && isProvisionalConversation(route) && !isProvisionalConversation(currentRoute)) {
          await followRoute(currentRoute);
        } else if (isProvisionalConversation(route) && isProvisionalConversation(currentRoute)) {
          route = currentRoute;
        } else if (run.snapshot().phase !== "preparing") {
          run.stop();
          await api("run.leave").catch(() => {});
          route = currentRoute;
        }
      }
      const latest = surface.reply();
      if (run.snapshot().active && latest && latest.id !== run.snapshot().lastTurn) view.pending(latest);
      await run.observe(!document.hidden);
      view.maskInternalMessages(profile.user);
    } finally { adapting = false; }
  };
  ticker = setInterval(() => { void tick().catch(error => report("[Relay]", error)); }, 600);
  document.addEventListener("visibilitychange", () => { void tick().catch(error => report("[Relay]", error)); });
  async function recover(attempt = 0): Promise<void> {
    if (run.snapshot().active) return;
    try {
      const saved = await api("run.status");
      if (run.snapshot().active) return;
      const state = saved.state as RunSnapshot | undefined;
      if (state?.active) { target = saved.target as WorkspaceTarget; access = saved.access === "observe" ? "observe" : saved.access === "autonomous" ? "autonomous" : "supervised"; runId = String(saved.runId); await run.restore(state); }
    } catch (error) {
      if (isExtensionContextInvalid(error)) { detach(); return; }
      if (attempt < 5) setTimeout(() => { void recover(attempt + 1); }, Math.min(5000, 500 * 2 ** attempt));
      else console.warn("[Relay recovery]", error);
    }
  }
  void recover();
  const restoreCards = () => {
    try {
      view.historical(surface.history());
      view.maskInternalMessages(profile.user);
    } catch (error) {
      console.warn("[Relay cards]", error);
    }
  };
  setTimeout(restoreCards, 1000);
  let scrollTimer: ReturnType<typeof setTimeout>;
  document.addEventListener("scroll", () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(restoreCards, 400); }, true);
}
