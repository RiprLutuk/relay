export function controlCenterHtml(): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:12px;color:var(--vscode-foreground);font:var(--vscode-font-size)/1.5 var(--vscode-font-family)}
  .connection{display:flex;align-items:center;gap:8px;font-weight:600}.dot{width:7px;height:7px;border-radius:50%;background:var(--vscode-descriptionForeground);flex-shrink:0}.dot.ok{background:var(--vscode-testing-iconPassed,#42b99a)}.dot.error{background:var(--vscode-errorForeground)}.dot.running{background:var(--vscode-progressBar-background)}
  #access{margin-left:auto;font-size:10px;font-weight:400;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.04em}
  #meta,.detail,.empty,time{color:var(--vscode-descriptionForeground);font-size:11px}#meta{margin:4px 0 12px 15px}
  button{font:inherit;font-size:11px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);padding:5px 9px;border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:focus-visible,summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}button:disabled{opacity:.5;cursor:default}
  .actions{display:flex;gap:6px;flex-wrap:wrap}.setup{margin-top:10px;color:var(--vscode-descriptionForeground);font-size:11px}.setup button{margin-top:7px}summary{cursor:pointer}
  h2{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:18px 0 6px;color:var(--vscode-descriptionForeground)}
  .event{display:grid;grid-template-columns:7px minmax(0,1fr);gap:8px;padding:7px 0;border-bottom:1px solid var(--vscode-widget-border,transparent)}.event .dot{margin-top:6px}.event:last-child{border-bottom:0}.label{font-size:12px;font-weight:500;overflow-wrap:anywhere}.detail{display:block;margin:2px 0 0;overflow-wrap:anywhere;max-height:3em;overflow:hidden}time{display:block;margin-top:2px;font-variant-numeric:tabular-nums}.empty{margin:8px 0}
</style></head><body>
  <section aria-label="Relay connection" aria-live="polite"><div class="connection"><i id="connection-dot" class="dot" aria-hidden="true"></i><span id="connection-label">Checking connection…</span><span id="access"></span></div><p id="meta">Local workspace bridge</p></section>
  <div class="actions"><button id="copy-pairing" type="button" title="Copy local token for pairing the browser extension">Copy pairing token</button><button id="start-bridge" type="button" hidden>Start bridge</button></div>
  <details class="setup"><summary>Setup</summary><button id="browser-companion" type="button">Open browser companion</button><p>Load this prepared folder in your browser's Extensions page once. Paste the pairing token only in the Relay popup.</p><details><summary>Advanced</summary><button id="select-binary" type="button">Override Relay binary</button></details></details>
  <h2>Activity</h2><div id="activity" role="log" aria-label="Agent tool activity"><p class="empty">No agent tool activity yet.</p></div>
<script>
  const api=acquireVsCodeApi();
  document.getElementById('copy-pairing').addEventListener('click',()=>api.postMessage({type:'copy'}));
  document.getElementById('start-bridge').addEventListener('click',()=>api.postMessage({type:'start'}));
  document.getElementById('select-binary').addEventListener('click',()=>api.postMessage({type:'choose'}));
  document.getElementById('browser-companion').addEventListener('click',()=>api.postMessage({type:'browser'}));
  let previousActivity='';
  window.addEventListener('message',event=>{
    const state=event.data.state;if(!state)return;
    document.getElementById('connection-label').textContent=state.online?(state.alive?'Connected':'MCP unavailable'):'Offline';
    document.getElementById('connection-dot').className='dot '+(state.online&&state.alive?'ok':'error');
    document.getElementById('access').textContent=state.online?'EDITOR':'';
    document.getElementById('meta').textContent=state.online?state.tools+' tools · '+state.servers.length+' server'+(state.servers.length===1?'':'s'):(state.error||'Open the workspace to start Relay');
    document.getElementById('start-bridge').hidden=state.online;
    const entries=(state.activity||[]).slice(0,6),signature=JSON.stringify(entries);
    if(signature===previousActivity)return;previousActivity=signature;
    const log=document.getElementById('activity');log.replaceChildren();
    if(!entries.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='No agent tool activity yet.';log.append(empty);return;}
    for(const item of entries){
      const row=document.createElement('div');row.className='event';
      const dot=document.createElement('i');dot.className='dot '+(['ok','running','error'].includes(item.kind)?item.kind:'');dot.setAttribute('aria-hidden','true');
      const content=document.createElement('div'),label=document.createElement('div');label.className='label';label.textContent=item.label;content.append(label);
      if(item.detail){const detail=document.createElement('p');detail.className='detail';detail.textContent=item.detail;detail.title=item.detail;content.append(detail);}
      if(item.at){const time=document.createElement('time'),date=new Date(item.at);if(Number.isFinite(date.getTime())){time.dateTime=date.toISOString();time.textContent=date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});content.append(time);}}
      row.append(dot,content);log.append(row);
    }
  });
</script></body></html>`;
}
