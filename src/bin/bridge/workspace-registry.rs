#![allow(non_snake_case)]
use super::*;
use std::{path::Path, sync::Mutex as StdMutex};
use tokio::sync::watch;

const LEASE_SECONDS: u64 = 30;

pub(super) fn randomId() -> Result<String> {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| anyhow!("OS random generator unavailable"))?;
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}

struct Lease {
    touched: StdMutex<std::time::Instant>,
    persistent: bool,
    cancelled: watch::Sender<bool>,
}
impl Lease {
    fn new(persistent: bool) -> Self {
        Self {
            touched: StdMutex::new(std::time::Instant::now()),
            persistent,
            cancelled: watch::channel(false).0,
        }
    }
    fn touch(&self) {
        *self.touched.lock().unwrap() = std::time::Instant::now();
    }
    fn invalidate(&self) {
        self.cancelled.send_replace(true);
    }
    fn valid(&self) -> bool {
        if !self.persistent
            && self.touched.lock().unwrap().elapsed() > Duration::from_secs(LEASE_SECONDS)
        {
            self.invalidate();
        }
        !*self.cancelled.borrow()
    }
}

struct Folder {
    original: PathBuf,
    canonical: PathBuf,
    #[cfg(unix)]
    identity: (u64, u64),
    #[cfg(not(unix))]
    created: Option<SystemTime>,
}
impl Folder {
    fn read(uri: &str) -> Result<Self> {
        let url = url::Url::parse(uri).context("Invalid folder URI")?;
        if url.scheme() != "file" {
            bail!("Only local file workspaces are supported; remote URI rejected");
        }
        let original = url
            .to_file_path()
            .map_err(|_| anyhow!("Invalid local folder URI"))?;
        let canonical = original
            .canonicalize()
            .context("Workspace folder is unavailable")?;
        let metadata = fs::metadata(&canonical)?;
        if !metadata.is_dir() {
            bail!("Workspace root must be a directory");
        }
        Ok(Self {
            original,
            canonical,
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (metadata.dev(), metadata.ino())
            },
            #[cfg(not(unix))]
            created: metadata.created().ok(),
        })
    }
    fn valid(&self) -> bool {
        if self.original.canonicalize().ok().as_ref() != Some(&self.canonical) {
            return false;
        }
        let Ok(metadata) = fs::metadata(&self.canonical) else {
            return false;
        };
        if !metadata.is_dir() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino()) == self.identity
        }
        #[cfg(not(unix))]
        {
            metadata.created().ok() == self.created
        }
    }
}

struct Workspace {
    id: String,
    owner: String,
    window: String,
    editor: Value,
    name: String,
    folder: Folder,
    lease: Arc<Lease>,
}
impl Workspace {
    fn valid(&self) -> bool {
        self.lease.valid() && self.folder.valid()
    }
    fn metadata(&self) -> Value {
        json!({"id":self.id,"windowId":self.window,"editor":self.editor,"name":self.name,"path":self.folder.canonical,"uri":url::Url::from_directory_path(&self.folder.canonical).unwrap().to_string()})
    }
}
struct Owner {
    signature: Value,
    ids: Vec<String>,
    lease: Arc<Lease>,
}

pub(super) struct Session {
    pub id: String,
    workspace: Arc<Workspace>,
    pub servers: HashMap<String, SharedServer>,
    pub journal: super::executionJournal::ExecutionJournal,
    access: Mutex<String>,
    cancelled: watch::Sender<bool>,
}
impl Session {
    pub(super) fn valid(&self) -> Result<()> {
        if *self.cancelled.borrow() || !self.workspace.valid() {
            bail!(
                "Workspace unavailable or changed. Select a live target and start a new chat session."
            );
        }
        Ok(())
    }
    pub async fn metadata(&self) -> Value {
        json!({"sessionId":self.id,"workspaceId":self.workspace.id,"workspace":self.workspace.metadata(),"access":self.access.lock().await.clone()})
    }
    pub async fn setAccess(&self, mode: &str) -> Result<()> {
        self.valid()?;
        if !matches!(mode, "workspace" | "full") {
            bail!("Invalid access mode");
        }
        let mut current = self.access.lock().await;
        if *current != mode {
            for server in self.servers.values() {
                let mut s = server.lock().await;
                s.stop().await;
                self.valid()?;
                s.start(mode).await?;
            }
            *current = mode.to_owned();
        }
        self.valid()
    }
    pub async fn call(&self, name: &str, args: Value, seconds: u64) -> Result<Value> {
        self.valid()?;
        let (server, bare) = resolveFor(&self.servers, name)
            .await
            .ok_or_else(|| anyhow!("Unknown or unavailable MCP tool: {name}"))?;
        let mut windowClosed = self.workspace.lease.cancelled.subscribe();
        let mut sessionClosed = self.cancelled.subscribe();
        let mut s = tokio::select! {
            guard = server.lock() => guard,
            _ = windowClosed.changed() => bail!("Workspace closed"),
            _ = sessionClosed.changed() => bail!("Session ended"),
        };
        self.valid()?;
        let result = tokio::select! {
            result = s.call(&bare,args,seconds) => result,
            _ = windowClosed.changed() => { s.stop().await; bail!("Workspace closed during execution"); },
            _ = sessionClosed.changed() => { s.stop().await; bail!("Session ended during execution"); },
        };
        self.valid()?;
        result
    }
    fn close(self: Arc<Self>) {
        self.cancelled.send_replace(true);
        tokio::spawn(async move {
            self.finish().await;
        });
    }
    async fn finish(&self) {
        self.cancelled.send_replace(true);
        for server in self.servers.values() {
            server.lock().await.stop().await;
        }
    }
}

#[derive(Default)]
struct State {
    owners: HashMap<String, Owner>,
    workspaces: HashMap<String, Arc<Workspace>>,
    sessions: HashMap<String, Arc<Session>>,
}
impl State {
    fn remove(&mut self, owner: &str) {
        if let Some(entry) = self.owners.remove(owner) {
            entry.lease.invalidate();
            for id in entry.ids {
                self.workspaces.remove(&id);
            }
            let ids: Vec<_> = self
                .sessions
                .iter()
                .filter(|(_, s)| s.workspace.owner == owner)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(s) = self.sessions.remove(&id) {
                    s.close();
                }
            }
        }
    }
}
pub(super) struct Router {
    state: Mutex<State>,
    templates: HashMap<String, Value>,
    pub epoch: String,
}
impl Router {
    pub fn new(templates: HashMap<String, Value>) -> Result<Self> {
        Ok(Self {
            state: Mutex::new(State::default()),
            templates,
            epoch: randomId()?,
        })
    }
    pub async fn register(&self, owner: &str, r: &Value, persistent: bool) -> Result<Vec<Value>> {
        let mut state = self.state.lock().await;
        let signature = json!({"editor":r["editor"],"windowId":r["windowId"],"roots":r["roots"],"trusted":r["trusted"]});
        if let Some(old) = state.owners.get(owner)
            && old.signature == signature
            && old
                .ids
                .iter()
                .all(|id| state.workspaces.get(id).is_some_and(|w| w.valid()))
        {
            old.lease.touch();
            return Ok(old
                .ids
                .iter()
                .map(|id| state.workspaces[id].metadata())
                .collect());
        }

        state.remove(owner);
        if r["trusted"] != true {
            bail!("Workspace is not trusted");
        }
        let window = r["windowId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .context("Window identity required")?;
        let editor = &r["editor"];
        for key in ["id", "name"] {
            if editor[key]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 128)
            {
                bail!("Editor identity required");
            }
        }
        let roots = r["roots"]
            .as_array()
            .filter(|roots| roots.len() <= 64)
            .context("Expected at most 64 workspace folders")?;
        let lease = Arc::new(Lease::new(persistent));
        let mut entries = Vec::new();
        let mut canonicalRoots = std::collections::HashSet::new();
        for root in roots {
            let folder = Folder::read(root["uri"].as_str().context("Folder URI required")?)?;
            if !canonicalRoots.insert(folder.canonical.clone()) {
                continue;
            }
            let name = root["name"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    folder
                        .canonical
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                });
            entries.push(Arc::new(Workspace {
                id: randomId()?,
                owner: owner.to_owned(),
                window: window.to_owned(),
                editor: editor.clone(),
                name,
                folder,
                lease: lease.clone(),
            }));
        }
        let ids = entries.iter().map(|w| w.id.clone()).collect();
        let out = entries.iter().map(|w| w.metadata()).collect();
        for workspace in entries {
            state.workspaces.insert(workspace.id.clone(), workspace);
        }
        state.owners.insert(
            owner.to_owned(),
            Owner {
                signature,
                ids,
                lease,
            },
        );
        Ok(out)
    }
    pub async fn heartbeat(&self, owner: &str) -> Result<()> {
        let state = self.state.lock().await;
        let entry = state
            .owners
            .get(owner)
            .context("Register this window first")?;
        if !entry.lease.valid() {
            bail!("Window registration expired; register again");
        }
        entry.lease.touch();
        Ok(())
    }
    pub async fn unregister(&self, owner: &str) {
        self.state.lock().await.remove(owner);
    }
    pub async fn expire(&self) {
        let mut state = self.state.lock().await;
        let expired: Vec<_> = state
            .owners
            .iter()
            .filter(|(_, o)| {
                !o.lease.valid() || o.ids.iter().any(|id| !state.workspaces[id].folder.valid())
            })
            .map(|(id, _)| id.clone())
            .collect();
        for owner in expired {
            state.remove(&owner);
        }
    }
    pub async fn list(&self) -> Vec<Value> {
        self.expire().await;
        let state = self.state.lock().await;
        let mut entries: Vec<_> = state.workspaces.values().map(|w| w.metadata()).collect();
        entries.sort_by_key(|v| format!("{}:{}:{}", v["editor"]["name"], v["path"], v["windowId"]));
        entries
    }
    pub async fn bind(&self, id: &str) -> Result<Arc<Session>> {
        self.expire().await;
        let workspace = {
            let state = self.state.lock().await;
            if state.sessions.len() >= 128 {
                bail!("Too many active sessions; end unused sessions first");
            }
            state
                .workspaces
                .get(id)
                .cloned()
                .context("Selected workspace is unavailable")?
        };
        let mut servers = HashMap::new();
        for (id, template) in &self.templates {
            let mut config = template.clone();
            if !config["env"].is_object() {
                config["env"] = json!({});
            }
            config["env"]["RELAY_WORKSPACE"] = json!(workspace.folder.canonical);
            let mut server = Server::new(id.clone(), config);
            if let Err(error) = server.start("workspace").await {
                server.error = Some(error.to_string());
                if id == "workspace" {
                    return Err(error);
                }
            }
            servers.insert(id.clone(), Arc::new(Mutex::new(server)));
        }
        let session = Arc::new(Session {
            id: randomId()?,
            workspace,
            servers,
            journal: super::executionJournal::ExecutionJournal::default(),
            access: Mutex::new("workspace".into()),
            cancelled: watch::channel(false).0,
        });
        session.valid()?;
        self.state
            .lock()
            .await
            .sessions
            .insert(session.id.clone(), session.clone());
        Ok(session)
    }
    pub async fn session(&self, r: &Value) -> Result<Arc<Session>> {
        let state = self.state.lock().await;
        let id = r["sessionId"]
            .as_str()
            .context("Select a workspace and start a session first")?;
        let workspace = r["workspaceId"]
            .as_str()
            .context("Workspace identity required")?;
        let session = state
            .sessions
            .get(id)
            .cloned()
            .context("Session is unavailable; start a new session")?;
        if session.workspace.id != workspace {
            bail!("Session workspace mismatch; target cannot be changed");
        }
        session.valid()?;
        Ok(session)
    }
    pub async fn end(&self, r: &Value) -> Result<()> {
        let session = self.session(r).await?;
        self.state.lock().await.sessions.remove(&session.id);
        session.finish().await;
        Ok(())
    }
    pub async fn headless(&self, path: &Path) -> Result<()> {
        self.register("headless",&json!({"editor":{"id":"cli","name":"CLI","version":env!("CARGO_PKG_VERSION")},"windowId":"headless","trusted":true,"roots":[{"uri":url::Url::from_directory_path(path.canonicalize()?).map_err(|_|anyhow!("Invalid workspace path"))?.to_string()}]}),true).await?;
        Ok(())
    }
    pub async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        for owner in state.owners.values() {
            owner.lease.invalidate();
        }
        for session in state.sessions.values() {
            session.cancelled.send_replace(true);
            for server in session.servers.values() {
                server.lock().await.stop().await;
            }
        }
        state.sessions.clear();
        state.workspaces.clear();
        state.owners.clear();
    }
}
