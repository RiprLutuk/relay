import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

from playwright.sync_api import sync_playwright


fixture = """<!doctype html><html><body style="background:#17191e;color:#eee;font:15px system-ui;margin:32px">
<h2>Relay browser contract test</h2><main></main><div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Ask ChatGPT" style="border:1px solid #555;padding:12px"></div><button data-testid="send-button">Send</button>
<script>
let counter=Number(sessionStorage.getItem('fixtureCounter')||'0'), step=0;
const history=sessionStorage.getItem('fixtureHistory');if(history)document.querySelector('main').innerHTML=history;
const marker=location.pathname.endsWith('a')?'project A':'project B';
document.querySelector('button').onclick=()=>{
 const input=document.querySelector('#prompt-textarea');const text=input.innerText.trim();if(!text)return;
 const user=document.createElement('div');user.dataset.userMessageBubble='';const content=document.createElement('span');content.textContent=text;user.append(content);document.querySelector('main').append(user);input.textContent='';
 const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.body.append(stop);
 setTimeout(()=>{
  let answer;
  if(text.startsWith('<relay-context>'))answer='Workspace ready.';
  else if(text.startsWith('<relay-receipt>')){
   if(step===1){step=2;answer=frame('workspace.readText',{path:'generated.txt'});}
   else{step=3;answer=text.includes(marker)?'Verified '+marker:'Verification failed';document.body.dataset.finished=answer;}
  }else if(text==='Read existing'){step=2;answer=frame('workspace.readText',{path:'generated.txt'});}
  else{step=1;answer=frame('workspace.create',{path:'generated.txt',content:marker});}
  const wrapper=document.createElement('article');wrapper.dataset.testid='conversation-turn-'+(++counter);
  const classic=document.createElement('div');classic.dataset.messageAuthorRole='assistant';
  const message=document.createElement('div');message.className='DilResponseRoot';message.dataset.dilMessageId='fixture-'+counter;
  const pre=document.createElement('pre');const code=document.createElement('code');
  if(answer.startsWith('<relay-action>')){
   const explanation=document.createElement('p');explanation.textContent='Inspecting the selected workspace.';message.append(explanation);
   const toolbar=document.createElement('div');toolbar.textContent='relay';pre.append(toolbar);
   const virtual=document.createElement('div');virtual.className='cm-content';virtual.textContent='Only a virtualized preview is rendered';virtual.cmTile={view:{state:{doc:{length:answer.length,toString:()=>answer}}}};code.append(virtual);
  }else code.textContent=answer;
  pre.append(code);message.append(pre);classic.append(message);wrapper.append(classic);document.querySelector('main').append(wrapper);sessionStorage.setItem('fixtureCounter',String(counter));stop.remove();
 },150);
};
function frame(tool,input){return '<relay-action>'+JSON.stringify({tool,input})+'</relay-action>';}
</script></body></html>"""


def verifyFlow():
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="relay-browser-flow-") as directory:
        directory = Path(directory)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        state = directory / "state"
        state.mkdir()
        roots = [directory / "editor-a/project", directory / "editor-b/project", directory / "extra"]
        for folder in roots:
            folder.mkdir(parents=True)
        environment = {**os.environ, "RELAY_BRIDGE_PORT": str(port), "RELAY_STATE_DIR": str(state), "RELAY_CONFIG": str(directory / "config.json")}
        environment.pop("RELAY_WORKSPACE", None)
        bridge = subprocess.Popen([str(root / "target/debug/relay-bridge")], env=environment, cwd=directory, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        owner = None
        try:
            for attempt in range(100):
                if (state / "bridge-token").exists():
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                            break
                    except OSError:
                        pass
                time.sleep(0.05)
            token = (state / "bridge-token").read_text().strip()
            helper = """
const {EditorSession}=require(process.argv[1]);const {pathToFileURL}=require('node:url');
const [tokenPath,endpoint,...roots]=process.argv.slice(2);
const make=(id,folders)=>new EditorSession(tokenPath,()=>({editor:{id,name:id,version:'contract-test'},windowId:id+'-window',trusted:true,roots:folders.map(path=>({name:'project',uri:pathToFileURL(path+'/').href}))}),endpoint);
const sessions=[make('vscode',[roots[0],roots[2]]),make('cursor',[roots[1]])];
sessions.forEach(session=>session.connect());process.stdin.resume();
process.on('SIGTERM',()=>{sessions.forEach(session=>session.dispose());setTimeout(()=>process.exit(),50);});
"""
            owner = subprocess.Popen(["node", "-e", helper, str(root / "apps/vscode-extension/out/editor-session.js"), str(state / "bridge-token"), f"ws://127.0.0.1:{port}", *map(str, roots)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            extension = directory / "extension"
            extension.mkdir()
            for name in ["manifest.json", "control-popup.html", "icon.png", "relay-mark.svg"]:
                shutil.copyfile(root / "apps/extension" / name, extension / name)
            if os.environ.get("RELAY_TEST_LATE_ATTACH"):
                manifest = json.loads((extension / "manifest.json").read_text())
                manifest.pop("content_scripts")
                (extension / "manifest.json").write_text(json.dumps(manifest))
            build = """
const {buildSync}=require(process.argv[1]);const [source,destination,endpoint]=process.argv.slice(2);
buildSync({absWorkingDir:source,entryPoints:{conversation:'src/conversation-entry.ts',transport:'src/transport-entry.ts',controls:'src/controls-entry.ts',document:'src/document-entry.ts'},outdir:destination+'/build',bundle:true,platform:'browser',format:'iife',target:'chrome120',define:{relayBridgeEndpoint:JSON.stringify(endpoint)},legalComments:'none',minifyWhitespace:true});
"""
            subprocess.run(["node", "-e", build, str(root / "apps/extension/node_modules/esbuild"), str(root / "apps/extension"), str(extension), f"ws://127.0.0.1:{port}"], check=True)
            with sync_playwright() as playwright:
                launch = {"headless": True, "args": [f"--disable-extensions-except={extension}", f"--load-extension={extension}"], "ignore_default_args": ["--disable-extensions"]}
                if os.environ.get("RELAY_TEST_BROWSER"):
                    launch["executable_path"] = os.environ["RELAY_TEST_BROWSER"]
                browser = playwright.chromium.launch_persistent_context(str(directory / "browser"), **launch)
                try:
                    browser.route("https://chatgpt.com/**", lambda route: route.fulfill(status=200, content_type="text/html", body=fixture))
                    worker = browser.service_workers[0] if browser.service_workers else browser.wait_for_event("serviceworker")
                    extensionId = worker.url.split("/")[2]
                    pages = []
                    for name in ["a", "b"]:
                        page = browser.new_page()
                        page.goto("https://chatgpt.com/c/relay-fixture-" + name)
                        page.wait_for_selector("#prompt-textarea")
                        pages.append(page)
                    if os.environ.get("RELAY_TEST_LATE_ATTACH"):
                        worker.evaluate("""() => chrome.scripting.registerContentScripts([
                          {id:'fixture-document',matches:['https://chatgpt.com/*'],js:['build/document.js'],world:'MAIN',runAt:'document_start'},
                          {id:'fixture-conversation',matches:['https://chatgpt.com/*'],js:['build/conversation.js'],runAt:'document_idle'}
                        ])""")
                    popup = browser.new_page()
                    popup.goto(f"chrome-extension://{extensionId}/control-popup.html")
                    pairing = popup.evaluate("token => chrome.runtime.sendMessage({method:'control.pair',token})", token)
                    assert pairing["ok"], "Pairing should be approved only from the popup"
                    tabs = worker.evaluate("() => chrome.tabs.query({url:'https://chatgpt.com/*'})")
                    tabIds = {entry["url"].rsplit("-", 1)[-1]: entry["id"] for entry in tabs}

                    def request(method, **fields):
                        return popup.evaluate("message => chrome.runtime.sendMessage(message)", {"method": method, **fields})

                    status = None
                    for attempt in range(100):
                        status = request("control.status", tab=tabIds["a"])
                        if len(status.get("workspaces", [])) == 3:
                            break
                        page.wait_for_timeout(100)
                    assert len(status.get("workspaces", [])) == 3, f"Editor roots missing: {status}"
                    targets = {entry["path"]: entry["id"] for entry in status["workspaces"]}
                    if os.environ.get("RELAY_TEST_STARTUP_FAILURE"):
                        pages[0].bring_to_front()
                        pages[0].locator('#prompt-textarea').fill("Keep this unsent draft")
                        failed = request("control.start", tab=tabIds["a"], workspace=targets[str(roots[0].resolve())], access="workspace")
                        assert failed.get("ok") is False and "unsent draft" in failed.get("error", ""), failed
                        for attempt in range(3):
                            popup.wait_for_timeout(1600)
                            failure = request("control.status", tab=tabIds["a"])
                            assert "unsent draft" in failure.get("error", ""), "Startup errors must survive popup status polling"
                        assert pages[0].locator('#prompt-textarea').inner_text() == "Keep this unsent draft"
                        pages[0].locator('#prompt-textarea').fill("")
                    for page, name, folder in zip(pages, ["a", "b"], roots[:2]):
                        page.bring_to_front()
                        started = request("control.start", tab=tabIds[name], workspace=targets[str(folder.resolve())], access="full" if name == "a" else "workspace", approved=name == "a")
                        assert started.get("ok"), started
                        expectedAccess = "Access: Full access (approved for this session)." if name == "a" else "Access: Workspace."
                        assert expectedAccess in page.locator('main').text_content(), "Bootstrap must describe the actual selected access mode"
                        page.locator('#prompt-textarea').fill("Create a file and verify it")
                        page.locator('[data-testid="send-button"]').click()
                        page.wait_for_function("document.body.dataset.finished?.startsWith('Verified')", timeout=30000)
                        assert (folder / "generated.txt").read_text() == "project " + name.upper()
                        assert not page.locator('main').inner_text().startswith('<relay-action>')
                        assert page.locator('[data-relay-card]').count() >= 3
                    assert (roots[0] / "generated.txt").read_text() == "project A"
                    assert (roots[1] / "generated.txt").read_text() == "project B"
                    assert not (roots[2] / "generated.txt").exists()
                    assert request("control.status", tab=tabIds["a"])["state"]["active"]
                    assert request("control.status", tab=tabIds["b"])["state"]["active"]
                    for attempt in range(50):
                        if not request("control.status", tab=tabIds["b"])["state"].get("pendingReply"):
                            break
                        pages[1].wait_for_timeout(100)
                    pages[1].evaluate("sessionStorage.setItem('fixtureHistory',document.querySelector('main').innerHTML)")
                    messages = pages[1].locator('[data-dil-message-id]').count()
                    pages[1].reload()
                    pages[1].wait_for_timeout(3500)
                    assert pages[1].locator('[data-dil-message-id]').count() == messages, "Reload must not replay history or inject a new bootstrap"
                    restored = pages[1].locator('[data-relay-card]').evaluate_all("elements => elements.filter(element => element.shadowRoot?.querySelector('summary')).length")
                    assert restored >= 5, "History must keep readable cards after reload"
                    devtools = browser.new_cdp_session(popup)
                    devtools.send("ServiceWorker.enable")
                    devtools.send("ServiceWorker.stopAllWorkers")
                    for attempt in range(100):
                        status = request("control.status", tab=tabIds["b"])
                        if status.get("connected") and status.get("state", {}).get("active"):
                            break
                        popup.wait_for_timeout(100)
                    assert status.get("connected") and status["state"]["active"], "Worker restart must recover the bound session"
                    (roots[1] / "generated.txt").write_text("project B updated")
                    pages[1].bring_to_front()
                    pages[1].locator('#prompt-textarea').fill("Read existing")
                    pages[1].locator('[data-testid="send-button"]').click()
                    pages[1].wait_for_function("document.body.dataset.finished?.startsWith('Verified')", timeout=30000)
                    assert "project B updated" in pages[1].locator('main').text_content(), "A new read must observe external edits rather than reuse an earlier turn's receipt"
                    oldRun = request("control.status", tab=tabIds["a"])["runId"]
                    request("control.stop", tab=tabIds["a"])
                    assert request("control.status", tab=tabIds["b"])["state"]["active"], "Stopping A must not stop B"
                    pages[0].bring_to_front()
                    replacement = request("control.start", tab=tabIds["a"], workspace=targets[str(roots[1].resolve())], access="workspace")
                    assert replacement.get("ok"), replacement
                    isolated = browser.new_cdp_session(pages[0])
                    worlds = []
                    isolated.on("Runtime.executionContextCreated", lambda event: worlds.append(event["context"]))
                    isolated.send("Runtime.enable")
                    world = None
                    for candidate in worlds:
                        identity = isolated.send("Runtime.evaluate", {"contextId": candidate["id"], "expression": "typeof chrome !== 'undefined' && chrome.runtime?.id", "returnByValue": True})
                        if identity.get("result", {}).get("value") == extensionId:
                            world = candidate["id"]
                            break
                    assert world is not None, "The test must send the stale action from the actual conversation content-script world"
                    stale = {"method": "run.execute", "runId": oldRun, "turn": "delayed-old-turn", "action": {"tool": "workspace.write", "input": {"path": "stale-action.txt", "content": "wrong project"}}}
                    rejected = isolated.send("Runtime.evaluate", {"contextId": world, "expression": "chrome.runtime.sendMessage(" + json.dumps(stale) + ")", "awaitPromise": True, "returnByValue": True})["result"]["value"]
                    assert rejected.get("ok") is False, "A delayed action must not acquire a replacement run's target"
                    assert not (roots[0] / "stale-action.txt").exists()
                    assert not (roots[1] / "stale-action.txt").exists()
                    request("control.stop", tab=tabIds["a"])
                    pages[1].bring_to_front()
                    pages[1].set_viewport_size({"width": 360, "height": 740})
                    assert pages[1].evaluate("document.documentElement.scrollWidth <= innerWidth")
                    pages[1].screenshot(path="/tmp/relay-browser-flow.png")
                    print("PASS real extension + EditorSession + Rust/MCP: isolated roots, receipts, history reload, worker recovery, fresh reads, independent stop, stale-run rejection after target replacement and mobile cards")
                finally:
                    browser.close()
        finally:
            if owner:
                owner.terminate()
                owner.wait(timeout=5)
            bridge.terminate()
            bridge.wait(timeout=5)


if __name__ == "__main__":
    verifyFlow()
