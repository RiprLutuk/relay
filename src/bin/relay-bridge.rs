#![allow(non_snake_case)]
use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use rand::TryRngCore;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    time::timeout,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{ErrorResponse, Request, Response},
    },
};

const PROTOCOL: &str = "2024-11-05";
fn stateDirectory() -> PathBuf {
    if let Some(path) = env::var_os("RELAY_STATE_DIR") {
        return PathBuf::from(path);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".relay")
}
fn loadPairingToken() -> Result<String> {
    let dir = stateDirectory();
    fs::create_dir_all(&dir)?;
    #[cfg(windows)]
    {
        let user = std::process::Command::new("whoami")
            .output()
            .context("identifying token owner")?;
        let user = String::from_utf8(user.stdout)?.trim().to_owned();
        if user.is_empty() {
            bail!("Cannot identify token owner");
        }
        let result = std::process::Command::new("icacls")
            .arg(&dir)
            .args([
                "/inheritance:r",
                "/grant:r",
                &format!("{user}:(OI)(CI)F"),
                "/Q",
            ])
            .output()?;
        if !result.status.success() {
            bail!("Cannot secure Relay state directory ACL");
        }
    }
    let path = dir.join("bridge-token");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    if let Ok(token) = fs::read_to_string(&path) {
        if token.trim().len() != 64 || !token.trim().bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("Invalid bridge-token file");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        }
        return Ok(token.trim().to_owned());
    }
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| anyhow!("OS random generator unavailable"))?;
    let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options
        .open(&path)?
        .write_all(format!("{token}\n").as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(token)
}
fn root() -> PathBuf {
    if let Some(path) = env::var_os("RELAY_ROOT") {
        return PathBuf::from(path);
    }
    env::current_dir().unwrap()
}
fn configPath() -> PathBuf {
    relay::configPath().expect("locating Relay configuration")
}
fn workspaceServerBinary() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent().map(|directory| {
                directory.join(format!("relay-workspace{}", std::env::consts::EXE_SUFFIX))
            })
        })
        .unwrap_or_else(|| root().join("target/release/relay-workspace"))
}
fn log(message: impl AsRef<str>) {
    eprintln!("{}", message.as_ref());
}

struct Process {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
}
struct Server {
    id: String,
    config: Value,
    process: Option<Process>,
    tools: Vec<Value>,
    error: Option<String>,
}
impl Server {
    fn new(id: String, config: Value) -> Self {
        Self {
            id,
            config,
            process: None,
            tools: vec![],
            error: None,
        }
    }
    fn alive(&mut self) -> bool {
        self.process
            .as_mut()
            .is_some_and(|p| p.child.try_wait().ok().flatten().is_none())
    }
    async fn start(&mut self, accessMode: &str) -> Result<()> {
        if self.alive() && !self.tools.is_empty() {
            return Ok(());
        }
        self.stop().await;
        let command = self.config["command"]
            .as_str()
            .ok_or_else(|| anyhow!("MCP server command is missing."))?;
        let args = self.config["args"]
            .as_array()
            .ok_or_else(|| anyhow!("MCP server args must be an array."))?;
        let mut cmd = Command::new(relay::platformCommand(command));
        #[cfg(windows)]
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        cmd.args(args.iter().filter_map(Value::as_str))
            .current_dir(
                self.config["env"]["RELAY_WORKSPACE"]
                    .as_str()
                    .map(PathBuf::from)
                    .unwrap_or_else(root),
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        if let Some(envs) = self.config["env"].as_object() {
            cmd.envs(envs.iter().filter_map(|(k, v)| v.as_str().map(|v| (k, v))));
        }
        cmd.env("RELAY_ACCESS_MODE", accessMode);
        let mut child = cmd
            .spawn()
            .with_context(|| format!("launching {command}"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("could not open MCP stdin"))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("could not open MCP stdout"))?,
        );
        self.process = Some(Process {
            child,
            input,
            output,
            next_id: 1,
        });
        let init = json!({"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"relay-bridge","version":env!("CARGO_PKG_VERSION")}});
        self.request("initialize", init, 12).await?;
        self.notify("notifications/initialized").await?;
        let listed = self.request("tools/list", json!({}), 20).await?;
        self.tools = listed["tools"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|v| v["name"].is_string())
            .collect();
        self.error = None;
        log(format!(
            "[{}] MCP server up ({} tools advertised)",
            self.id,
            self.tools.len()
        ));
        Ok(())
    }
    async fn stop(&mut self) {
        self.tools.clear();
        if let Some(mut p) = self.process.take() {
            let _ = p.input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"reason\":\"Relay session ended\"}}\n").await;
            let _ = p.input.flush().await;
            let _ = p.input.shutdown().await;
            if timeout(Duration::from_secs(2), p.child.wait())
                .await
                .is_err()
            {
                let _ = p.child.kill().await;
                let _ = p.child.wait().await;
            }
        }
    }
    async fn notify(&mut self, method: &str) -> Result<()> {
        self.send(json!({"jsonrpc":"2.0","method":method,"params":{}}))
            .await
    }
    async fn send(&mut self, v: Value) -> Result<()> {
        let p = self
            .process
            .as_mut()
            .ok_or_else(|| anyhow!("{} MCP server is offline.", self.id))?;
        p.input
            .write_all(format!("{}\n", serde_json::to_string(&v)?).as_bytes())
            .await?;
        p.input.flush().await?;
        Ok(())
    }
    async fn request(&mut self, method: &str, params: Value, seconds: u64) -> Result<Value> {
        let id = {
            let p = self
                .process
                .as_mut()
                .ok_or_else(|| anyhow!("{} MCP server is offline.", self.id))?;
            let id = p.next_id;
            p.next_id += 1;
            id
        };
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let fut = async {
            loop {
                let p = self
                    .process
                    .as_mut()
                    .ok_or_else(|| anyhow!("{} MCP server is offline.", self.id))?;
                let mut line = String::new();
                if p.output.read_line(&mut line).await? == 0 {
                    bail!("{} MCP server disconnected.", self.id)
                }
                let v: Value = serde_json::from_str(&line).context("invalid MCP JSON")?;
                if v["id"] == id {
                    if !v["error"].is_null() {
                        bail!("{}", v["error"]["message"].as_str().unwrap_or("MCP error"))
                    }
                    return Ok(v["result"].clone());
                }
            }
        };
        timeout(Duration::from_secs(seconds), fut)
            .await
            .context("MCP request timed out")?
    }
    async fn call(&mut self, name: &str, args: Value, seconds: u64) -> Result<Value> {
        self.request("tools/call", json!({"name":name,"arguments":args}), seconds)
            .await
    }
}
type SharedServer = Arc<Mutex<Server>>;
#[path = "bridge/execution-journal.rs"]
mod executionJournal;
#[path = "bridge/workspace-registry.rs"]
mod workspaceRegistry;
use workspaceRegistry::Router;
struct Bridge {
    servers: HashMap<String, SharedServer>,
    router: Router,
    activity: Mutex<Vec<Value>>,
    token: String,
    blocked: Mutex<HashMap<std::net::IpAddr, tokio::time::Instant>>,
}
impl Bridge {
    fn authorized(&self, candidate: &str) -> bool {
        candidate.len() == self.token.len()
            && candidate
                .bytes()
                .zip(self.token.bytes())
                .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                == 0
    }
    async fn load() -> Result<Self> {
        let path = configPath();
        let mut cfg: Value = if path.exists() {
            serde_json::from_str(&fs::read_to_string(&path)?).context("invalid config.json")?
        } else {
            json!({})
        };
        if !cfg["mcpServers"].is_object() {
            cfg["mcpServers"] = json!({});
        }

        cfg["mcpServers"]["workspace"] =
            json!({"command":workspaceServerBinary(),"args":[],"env":{}});
        if !path.exists() {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            relay::ensureConfig()?;
        }
        let mut servers = HashMap::new();
        let mut templates = HashMap::new();
        for (id, cfg) in cfg["mcpServers"].as_object().into_iter().flatten() {
            if id == "vscode" {
                continue;
            }
            if id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
                && id.len() <= 64
            {
                templates.insert(id.clone(), cfg.clone());
                servers.insert(
                    id.clone(),
                    Arc::new(Mutex::new(Server::new(id.clone(), cfg.clone()))),
                );
            }
        }
        let bridge = Self {
            servers,
            router: Router::new(templates)?,
            activity: Mutex::new(vec![]),
            token: loadPairingToken()?,
            blocked: Mutex::new(HashMap::new()),
        };
        if let Some(path) = env::var_os("RELAY_WORKSPACE") {
            bridge.router.headless(&PathBuf::from(path)).await?;
        }
        Ok(bridge)
    }
    async fn start(&self) {
        let accessMode = "workspace";
        for server in self.servers.values() {
            let mut s = server.lock().await;
            if let Err(e) = s.start(accessMode).await {
                s.error = Some(e.to_string());
                log(format!("[{}] startup failed: {e}", s.id));
            }
        }
    }
    async fn catalog(&self) -> Vec<Value> {
        catalogFor(&self.servers).await
    }
    async fn statuses(&self) -> Vec<Value> {
        statusesFor(&self.servers).await
    }
    async fn connected(&self) -> Value {
        let servers = self.statuses().await;
        json!({"type":"connected","protocolVersion":3,"bridgeId":self.router.epoch,"workspaces":self.router.list().await,"workspaceReady":servers.iter().any(|s|s["alive"]==true),"tools":self.catalog().await,"servers":servers,"access":"workspace","activity":self.activity.lock().await.clone()})
    }
    async fn activity(
        &self,
        kind: &str,
        label: impl Into<String>,
        detail: impl Into<String>,
        context: &Value,
    ) {
        let mut events = self.activity.lock().await;
        events.insert(0, json!({"kind":kind,"label":label.into().chars().take(120).collect::<String>(),"detail":detail.into().chars().take(1000).collect::<String>(),"workspaceId":context["workspaceId"],"sessionId":context["sessionId"],"at":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()}));
        events.truncate(16);
    }
    async fn handle(&self, r: Value, owner: Option<&str>) -> Value {
        let id = r["id"].clone();
        if !self.authorized(r["token"].as_str().unwrap_or("")) {
            log("unauthorized bridge request rejected");
            return json!({"type":"error","id":id,"error":"unauthorized"});
        }
        match r["type"].as_str() {
            Some("authenticate") => self.connected().await,
            Some("workspace.list") => {
                json!({"type":"workspaces","id":id,"ok":true,"bridgeId":self.router.epoch,"workspaces":self.router.list().await})
            }
            Some("workspace.register" | "workspace.heartbeat") => {
                let result = if let Some(owner) = owner {
                    if r["type"] == "workspace.register" {
                        self.router.register(owner, &r, false).await
                    } else {
                        self.router.heartbeat(owner).await.map(|_| Vec::new())
                    }
                } else {
                    Err(anyhow!(
                        "Only authenticated native editor connections may register workspaces"
                    ))
                };
                match result {
                    Ok(workspaces) => {
                        json!({"type":"workspaceState","id":id,"ok":true,"bridgeId":self.router.epoch,"workspaces":workspaces})
                    }
                    Err(e) => {
                        json!({"type":"workspaceState","id":id,"ok":false,"error":e.to_string()})
                    }
                }
            }
            Some("session.open") => match self
                .router
                .bind(r["workspaceId"].as_str().unwrap_or(""))
                .await
            {
                Ok(session) => {
                    let mut v = session.metadata().await;
                    v["type"] = json!("session");
                    v["id"] = id;
                    v["ok"] = json!(true);
                    v["bridgeId"] = json!(self.router.epoch);
                    v
                }
                Err(e) => {
                    json!({"type":"session","id":id,"ok":false,"kind":"workspaceUnavailable","error":e.to_string()})
                }
            },
            Some("session.inspect") => match self.router.session(&r).await {
                Ok(session) => {
                    let mut v = session.metadata().await;
                    v["type"] = json!("session");
                    v["id"] = id;
                    v["ok"] = json!(true);
                    v["bridgeId"] = json!(self.router.epoch);
                    v
                }
                Err(e) => {
                    json!({"type":"session","id":id,"ok":false,"kind":"workspaceUnavailable","error":e.to_string()})
                }
            },
            Some("session.close") => match self.router.end(&r).await {
                Ok(()) => json!({"type":"session","id":id,"ok":true}),
                Err(e) => json!({"type":"session","id":id,"ok":false,"error":e.to_string()}),
            },
            Some("ping") => json!({"type":"pong","id":id}),
            Some("capability.list") => {
                if r["sessionId"].is_string() {
                    return match self.router.session(&r).await {
                        Ok(session) => {
                            json!({"type":"tools","id":id,"ok":true,"tools":catalogFor(&session.servers).await,"servers":statusesFor(&session.servers).await})
                        }
                        Err(error) => {
                            json!({"type":"tools","id":id,"ok":false,"kind":"workspaceUnavailable","error":error.to_string()})
                        }
                    };
                }
                let mut v = self.connected().await;
                v["type"] = json!("tools");
                v["id"] = id;
                v
            }
            Some("capability.invoke") => {
                let name = match r["name"].as_str() {
                    Some(v) => v,
                    None => {
                        return json!({"type":"actionResult","id":id,"ok":false,"error":"Invalid tool call."});
                    }
                };
                let session = match self.router.session(&r).await {
                    Ok(session) => session,
                    Err(e) => {
                        return json!({"type":"actionResult","id":id,"ok":false,"kind":"workspaceUnavailable","error":e.to_string()});
                    }
                };

                let secs = r["timeout"]
                    .as_f64()
                    .map(|n| (n / 1000.0).clamp(1.0, 300.0) as u64)
                    .unwrap_or(120);
                self.activity("running", format!("Running {name}"), "Agent tool call", &r)
                    .await;
                let result = if let Some(operation) = r["operationId"].as_str() {
                    session
                        .journal
                        .resolve(
                            operation,
                            json!([name, r["arguments"]]),
                            session.call(name, r["arguments"].clone(), secs),
                        )
                        .await
                } else {
                    session.call(name, r["arguments"].clone(), secs).await
                };
                let result = result.and_then(|value| {
                    session.valid()?;
                    Ok(value)
                });
                match result {
                    Ok(result) => {
                        let mut text: Vec<String> = Vec::new();
                        let mut images = Vec::new();
                        for item in result["content"].as_array().into_iter().flatten() {
                            if item["type"] == "text" {
                                if let Some(s) = item["text"].as_str() {
                                    text.push(s.into())
                                }
                            } else if item["type"] == "image" {
                                images.push(json!({"data":item["data"],"mimeType":item["mimeType"].as_str().unwrap_or("image/png")}))
                            }
                        }
                        if text.is_empty() && !result["structuredContent"].is_null() {
                            text.push(result["structuredContent"].to_string())
                        }
                        let text = text.join("\n");
                        if result["isError"] == true {
                            self.activity("error", format!("{name} failed"), text.clone(), &r)
                                .await;
                            json!({"type":"actionResult","id":id,"ok":false,"error":text})
                        } else {
                            self.activity("ok", format!("{name} finished"), "Tool completed", &r)
                                .await;
                            json!({"type":"actionResult","id":id,"ok":true,"text":text,"images":images})
                        }
                    }
                    Err(e) => {
                        self.activity("error", format!("{name} failed"), e.to_string(), &r)
                            .await;
                        json!({"type":"actionResult","id":id,"ok":false,"kind":if session.valid().is_err(){"workspaceUnavailable"}else{"actionError"},"error":e.to_string()})
                    }
                }
            }
            Some("session.authorize") => {
                let result = async {
                    if r["access"] == "full" && r["confirm"] != true {
                        bail!("full access requires explicit confirmation");
                    }
                    let session = self.router.session(&r).await?;
                    session
                        .setAccess(r["access"].as_str().unwrap_or("workspace"))
                        .await?;
                    let mut v = session.metadata().await;
                    v["type"] = json!("accessState");
                    v["id"] = id.clone();
                    v["ok"] = json!(true);
                    v["alive"] = json!(true);
                    v["tools"] = json!(catalogFor(&session.servers).await);
                    v["servers"] = json!(statusesFor(&session.servers).await);
                    Ok::<_, anyhow::Error>(v)
                }
                .await;
                match result {
                    Ok(v) => v,
                    Err(e) => {
                        json!({"type":"accessState","id":id,"ok":false,"error":e.to_string()})
                    }
                }
            }
            _ => {
                json!({"type":"error","id":id,"error":format!("Unknown bridge request: {}",r["type"].as_str().unwrap_or(""))})
            }
        }
    }
}
async fn catalogFor(servers: &HashMap<String, SharedServer>) -> Vec<Value> {
    let mut raw = Vec::new();
    for s in servers.values() {
        let mut s = s.lock().await;
        if s.alive() {
            for t in &s.tools {
                raw.push((s.id.clone(), t.clone()))
            }
        }
    }
    let mut counts = HashMap::new();
    for (_, t) in &raw {
        *counts
            .entry(t["name"].as_str().unwrap_or("").to_owned())
            .or_insert(0usize) += 1;
    }
    raw.into_iter().map(|(server,t)|{let bare=t["name"].as_str().unwrap_or("");json!({"name":if counts[bare]>1{format!("{server}/{bare}")}else{bare.to_owned()},"server":server,"description":t["description"],"inputSchema":t["inputSchema"]})}).collect()
}

async fn statusesFor(servers: &HashMap<String, SharedServer>) -> Vec<Value> {
    let mut out = Vec::new();
    for s in servers.values() {
        let mut s = s.lock().await;
        let alive = s.alive();
        out.push(json!({"id":s.id,"alive":alive,"tools":if alive{s.tools.len()}else{0}}));
    }
    out
}

async fn resolveFor(
    servers: &HashMap<String, SharedServer>,
    name: &str,
) -> Option<(SharedServer, String)> {
    if let Some((id, bare)) = name.split_once('/') {
        let s = servers.get(id)?.clone();
        let mut x = s.lock().await;
        if x.alive() && x.tools.iter().any(|t| t["name"] == bare) {
            drop(x);
            return Some((s, bare.into()));
        }
    }
    let mut found = None;
    for s in servers.values() {
        let mut x = s.lock().await;
        if x.alive() && x.tools.iter().any(|t| t["name"] == name) {
            if found.is_some() {
                return None;
            }
            found = Some(s.clone())
        }
    }
    found.map(|s| (s, name.into()))
}

#[allow(clippy::result_large_err)]
async fn client(stream: tokio::net::TcpStream, bridge: Arc<Bridge>) -> Result<()> {
    let owner = workspaceRegistry::randomId()?;
    let result = async {
        let peer = stream.peer_addr()?.ip();
        if bridge
            .blocked
            .lock()
            .await
            .get(&peer)
            .is_some_and(|until| *until > tokio::time::Instant::now())
        {
            bail!("peer temporarily blocked after failed authentication");
        }
        let mut localAuthenticated = false;
        let ws = accept_hdr_async(stream, |request: &Request, response: Response| {
            let origin = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            localAuthenticated = origin.is_empty()
                && request
                    .headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Bearer "))
                    .is_some_and(|token| bridge.authorized(token));
            let extension = url::Url::parse(origin).ok().is_some_and(|url| {
                matches!(url.scheme(), "chrome-extension" | "moz-extension")
                    && url.host_str().is_some()
                    && url.path().is_empty()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.port().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
            });
            log(format!(
                "bridge connection origin={} allowed={} local_auth={}",
                if origin.is_empty() { "local" } else { origin },
                extension || localAuthenticated,
                localAuthenticated
            ));
            if extension || localAuthenticated {
                Ok(response)
            } else {
                log(format!("rejected bridge origin: {origin}"));
                let mut rejected = ErrorResponse::new(Some("Forbidden origin".into()));
                *rejected.status_mut() =
                    tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                Err(rejected)
            }
        })
        .await?;
        let (mut sink, mut input) = ws.split();
        let initial = if localAuthenticated {
            bridge.connected().await
        } else {
            json!({"type":"pairingRequired"})
        };
        sink.send(Message::Text(initial.to_string().into())).await?;
        let sink = Arc::new(Mutex::new(sink));
        let capacity = Arc::new(tokio::sync::Semaphore::new(16));
        let mut failures = 0;
        while let Some(message) = input.next().await {
            let message = message?;
            if !message.is_text() {
                continue;
            }
            let response = match serde_json::from_str::<Value>(message.to_text()?) {
                Ok(v) if v.is_object() => {
                    if !bridge.authorized(v["token"].as_str().unwrap_or("")) {
                        failures += 1;
                        log("bridge token validation failed");
                    }
                    if matches!(
                        v["type"].as_str(),
                        Some("capability.invoke" | "session.open" | "session.authorize")
                    ) && bridge.authorized(v["token"].as_str().unwrap_or(""))
                    {
                        if let Ok(permit) = capacity.clone().try_acquire_owned() {
                            let bridge = bridge.clone();
                            let sink = sink.clone();
                            let owner = owner.clone();
                            tokio::spawn(async move {
                                let response = bridge
                                    .handle(v, localAuthenticated.then_some(owner.as_str()))
                                    .await;
                                let _ = sink
                                    .lock()
                                    .await
                                    .send(Message::Text(response.to_string().into()))
                                    .await;
                                drop(permit);
                            });
                            continue;
                        }
                        json!({"type":"error","id":v["id"],"error":"Too many concurrent requests"})
                    } else {
                        bridge
                            .handle(v, localAuthenticated.then_some(owner.as_str()))
                            .await
                    }
                }
                _ => json!({"type":"error","error":"Invalid JSON request."}),
            };
            sink.lock()
                .await
                .send(Message::Text(response.to_string().into()))
                .await?;
            if failures >= 5 {
                bridge
                    .blocked
                    .lock()
                    .await
                    .insert(peer, tokio::time::Instant::now() + Duration::from_secs(30));
                let _ = sink.lock().await.send(Message::Close(None)).await;
                break;
            }
        }
        Ok(())
    }
    .await;
    bridge.router.unregister(&owner).await;
    result
}

#[tokio::main]
async fn main() -> Result<()> {
    let bridge = Arc::new(Bridge::load().await?);
    bridge.start().await;
    let port = env::var("RELAY_BRIDGE_PORT").unwrap_or_else(|_| "17613".into());
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    let instance = stateDirectory().join("bridge-instance.json");
    fs::write(&instance, json!({"pid":std::process::id(),"port":port,"version":env!("CARGO_PKG_VERSION"),"protocolVersion":3}).to_string())?;
    log(format!(
        "listening on ws://127.0.0.1:{port} - load the extension and open a supported AI chat"
    ));
    let registry = bridge.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            registry.router.expire().await;
        }
    });
    let shutdown = async {
        #[cfg(unix)]
        {
            let mut termination =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            tokio::select! { result = tokio::signal::ctrl_c() => result?, _ = termination.recv() => {} }
        }
        #[cfg(not(unix))]
        tokio::signal::ctrl_c().await?;
        Ok::<(), anyhow::Error>(())
    };
    tokio::pin!(shutdown);
    loop {
        let accepted =
            tokio::select! { accepted = listener.accept() => accepted, _ = &mut shutdown => break };
        let (stream, _) = accepted?;
        let b = bridge.clone();
        tokio::spawn(async move {
            if let Err(e) = client(stream, b).await {
                log(format!("extension disconnected: {e}"))
            };
        });
    }
    bridge.router.shutdown().await;
    for server in bridge.servers.values() {
        server.lock().await.stop().await;
    }
    let _ = fs::remove_file(instance);
    Ok(())
}
