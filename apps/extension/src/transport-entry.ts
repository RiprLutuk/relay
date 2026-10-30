import { BridgeLink, type BridgeMessage } from "./infrastructure/bridge-link";
import { ensureConversation } from "./infrastructure/conversation-host";
import type { ActivityEvent, Capability, RunSnapshot, WorkspaceBinding, WorkspaceTarget } from "./domain/contracts";

interface ConversationRecord {
  binding: WorkspaceBinding;
  target: WorkspaceTarget;
  tab: number;
  conversation: string;
  state: RunSnapshot;
  events: ActivityEvent[];
}

const storageKey = "relay.conversations.v1";
const failureKey = "relay.startupFailures.v1";
const records = new Map<string, ConversationRecord>();
const failures = new Map<string, string>();
const starting = new Set<string>();
let persistence = Promise.resolve();
let token = "";
const link = new BridgeLink(() => {});
const initialized = chrome.storage.local.get([storageKey, failureKey, "relayBridgeToken"]).then(saved => {
  token = typeof saved.relayBridgeToken === "string" && /^[a-f0-9]{64}$/i.test(saved.relayBridgeToken) ? saved.relayBridgeToken : "";
  for (const record of (saved[storageKey] || []) as ConversationRecord[]) if (record?.binding?.sessionId && typeof record.conversation === "string") records.set(record.conversation, record);
  if (Array.isArray(saved[failureKey])) for (const entry of saved[failureKey]) if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") failures.set(entry[0], entry[1]);
  link.pair(token);
});

function persist(): Promise<void> {
  const snapshot = [...records.values()].slice(-100);
  const errors = [...failures.entries()].slice(-100);
  persistence = persistence.catch(() => {}).then(() => chrome.storage.local.set({ [storageKey]: snapshot, [failureKey]: errors }));
  return persistence;
}

function conversationKey(url: string, tab: number): string {
  const parsed = new URL(url);
  const base = parsed.origin + parsed.pathname;
  return /^\/(?:new|app|chat)?\/?$/.test(parsed.pathname) ? `${base}#draft-${tab}` : base;
}

async function tabContext(tab: number): Promise<{ tab: number; url: string; key: string }> {
  const current = await chrome.tabs.get(tab);
  if (!current.url?.startsWith("https://")) throw new Error("Select a supported AI conversation tab.");
  return { tab, url: current.url, key: conversationKey(current.url, tab) };
}

function ownedRecord(key: string, tab: number): ConversationRecord {
  const record = records.get(key);
  if (!record || record.tab !== tab) throw new Error("This conversation has no workspace session. Start it from Relay's popup.");
  if (record.binding.bridgeId !== link.hello.bridgeId) throw new Error("The bridge restarted. Start a new workspace session.");
  return record;
}

async function boundRequest(record: ConversationRecord, request: BridgeMessage, timeout?: number): Promise<BridgeMessage> {
  const result = await link.request({ ...request, sessionId: record.binding.sessionId, workspaceId: record.binding.workspaceId }, timeout);
  if (result.ok === false) throw Object.assign(new Error(String(result.error || "Workspace request failed.")), { kind: result.kind });
  return result;
}

async function stopRecord(record: ConversationRecord): Promise<void> {
  record.state = { ...record.state, active: false, phase: "stopped" };
  await persist();
  await chrome.tabs.sendMessage(record.tab, { method: "conversation.stop", runId: record.binding.sessionId }).catch(() => {});
  try {
    await link.request({ type: "session.close", ...record.binding });
  } catch {
    record.state = { ...record.state, phase: "failed", error: "Relay stopped sending actions locally. The bridge is unreachable, so an in-flight action's outcome is unknown." };
    await persist();
    throw new Error(record.state.error);
  }
  records.delete(record.conversation);
  await persist();
}

async function handleControl(message: BridgeMessage): Promise<BridgeMessage> {
  if (message.method === "control.pair") {
    const value = String(message.token || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Paste the pairing token copied from your editor.");
    await chrome.storage.local.set({ relayBridgeToken: value });
    token = value;
    link.pair(value);
    return { ok: true };
  }
  const context = await tabContext(Number(message.tab));
  if (message.method === "control.status") {
    const response = link.ready() ? await link.request({ type: "workspace.list" }) : {};
    const record = records.get(context.key);
    if (record?.state.active && link.ready()) {
      try { await boundRequest(record, { type: "session.inspect" }); }
      catch (error) { record.state = { ...record.state, phase: "failed", active: false, error: String((error as Error).message) }; await persist(); }
    }
    return { ok: true, paired: !!token, connected: link.ready(), changing: starting.has(context.key), runId: record?.binding.sessionId, error: failures.get(context.key) || link.problem, workspaces: response.workspaces || [], target: record?.target, state: record?.state, events: record?.events || [], access: record?.binding.access };
  }
  if (message.method === "control.stop") {
    if (starting.has(context.key)) throw new Error("This session is changing. Wait for the current transition.");
    starting.add(context.key);
    try { const record = records.get(context.key); if (record) await stopRecord(record); return { ok: true }; }
    finally { starting.delete(context.key); }
  }
  if (message.method !== "control.start") throw new Error("Unknown popup action.");
  if (starting.has(context.key)) throw new Error("A workspace session is already starting.");
  const existing = records.get(context.key);
  if (existing?.state.active) throw new Error("Stop the current session before changing its workspace.");
  if (message.access === "full" && message.approved !== true) throw new Error("Full access requires explicit approval in this popup.");
  starting.add(context.key);
  let record: ConversationRecord | undefined;
  try {
    failures.delete(context.key);
    await persist();
    if (existing) await stopRecord(existing);
    await ensureConversation(context.tab, context.url);
    const bound = await link.request({ type: "session.open", workspaceId: message.workspace });
    if (bound.ok !== true) throw new Error(String(bound.error || "Workspace is unavailable."));
    record = {
      binding: { sessionId: String(bound.sessionId), workspaceId: String(bound.workspaceId), bridgeId: String(bound.bridgeId), access: "workspace" },
      target: bound.workspace as unknown as WorkspaceTarget,
      tab: context.tab, conversation: context.key,
      state: { conversation: context.key, active: true, phase: "preparing" }, events: [],
    };
    await boundRequest(record, { type: "session.authorize", access: message.access === "full" ? "full" : "workspace", confirm: message.access === "full" });
    record.binding.access = message.access === "full" ? "full" : "workspace";
    records.set(context.key, record);
    await persist();
    const reply = await chrome.tabs.sendMessage(context.tab, { method: "conversation.begin", target: record.target, runId: record.binding.sessionId, access: record.binding.access });
    if (!reply?.ok) throw new Error(reply?.error || "Reload the AI conversation to activate the new Relay browser extension.");
    return { ok: true };
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    if (record) try { await stopRecord(record); } catch (cleanup) { detail += ` ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`; }
    failures.delete(context.key);
    failures.set(context.key, detail.slice(0, 1000));
    while (failures.size > 100) failures.delete(failures.keys().next().value!);
    await persist();
    throw new Error(detail);
  } finally { starting.delete(context.key); }
}

async function handleConversation(message: BridgeMessage, sender: chrome.runtime.MessageSender): Promise<BridgeMessage> {
  const tab = sender.tab?.id;
  if (tab === undefined) throw new Error("A conversation tab is required.");
  const context = await tabContext(tab);
  if (message.method === "run.leave") {
    for (const record of [...records.values()]) if (record.tab === tab && record.binding.sessionId === message.runId && record.conversation !== context.key) await stopRecord(record);
    return { ok: true };
  }
  if (message.method === "run.adopt") {
    const previous = [...records.values()].find(record => record.tab === tab && record.binding.sessionId === message.runId && record.conversation.includes(`#draft-${tab}`) && record.state.phase === "preparing");
    if (!previous || !context.url.startsWith(new URL(previous.conversation).origin + "/")) throw new Error("Conversation changed. Start a new workspace session.");
    records.delete(previous.conversation);
    previous.conversation = context.key;
    previous.state.conversation = context.key;
    records.set(context.key, previous);
    await persist();
    return { ok: true };
  }
  if (message.method === "run.status") {
    const record = records.get(context.key);
    if (record?.tab === tab && record.state.active) {
      await link.ensureReady();
      try { await boundRequest(ownedRecord(context.key, tab), { type: "session.inspect" }); }
      catch (error) { record.state = { ...record.state, active: false, phase: "failed", error: (error as Error).message }; await persist(); }
    }
    return { ok: true, runId: record?.tab === tab ? record.binding.sessionId : undefined, state: record?.tab === tab ? record.state : undefined, target: record?.tab === tab ? record.target : undefined, access: record?.tab === tab ? record.binding.access : undefined };
  }
  await link.ensureReady();
  const record = ownedRecord(context.key, tab);
  if (message.runId !== record.binding.sessionId) throw new Error("This run was replaced or ended. Its actions cannot use a replacement session.");
  if (message.method === "run.catalog") {
    await boundRequest(record, { type: "session.inspect" });
    const response = await boundRequest(record, { type: "capability.list" });
    return { ok: true, capabilities: response.tools as Capability[] };
  }
  if (message.method === "run.update") {
    const state = message.state as RunSnapshot;
    const previous = record.state;
    record.state = { ...state, conversation: record.conversation };
    if (previous.phase !== state.phase || state.error !== previous.error) record.events.unshift({ at: Date.now(), phase: state.phase, title: state.phase, detail: state.error });
    record.events = record.events.slice(0, 24);
    await persist();
    return { ok: true };
  }
  if (message.method === "run.execute") {
    if (!record.state.active) throw new Error("This workspace session is stopped.");
    const action = message.action as { tool: string; input: Record<string, unknown> };
    if (!action || typeof action.tool !== "string" || !message.turn) throw new Error("An identified assistant action is required.");
    const bytes = new TextEncoder().encode(JSON.stringify([record.binding.sessionId, message.turn, action]));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const operation = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const result = await link.request({ type: "capability.invoke", sessionId: record.binding.sessionId, workspaceId: record.binding.workspaceId, name: action.tool, arguments: action.input, operationId: operation, timeout: 120000 }, 135000);
    record.events.unshift({ at: Date.now(), phase: result.ok ? "waiting" : "failed", title: action.tool, detail: result.ok ? "Completed" : String(result.error || "Failed").slice(0, 500) });
    record.events = record.events.slice(0, 24);
    await persist();
    return result;
  }
  throw new Error("Unknown conversation request.");
}

chrome.runtime.onMessage.addListener((message: BridgeMessage, sender, respond) => {
  void initialized.then(async () => {
    const popup = sender.url === chrome.runtime.getURL("control-popup.html");
    if (String(message.method).startsWith("control.")) {
      if (!popup) throw new Error("Workspace selection and approval are available only in Relay's popup.");
      return handleControl(message);
    }
    if (popup) throw new Error("Conversation actions must originate in their own chat tab.");
    return handleConversation(message, sender);
  }).then(respond, error => respond({ ok: false, kind: error.kind || (/offline|connection|restarted/i.test(error.message) ? "disconnected" : "workspaceUnavailable"), error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tab => { void initialized.then(async () => { for (const record of [...records.values()]) if (record.tab === tab) await stopRecord(record).catch(() => {}); }); });
