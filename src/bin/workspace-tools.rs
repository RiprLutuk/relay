#![allow(non_snake_case)]
use anyhow::{Context, Result, anyhow, bail};
use globset::{Glob, GlobMatcher};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use walkdir::WalkDir;

const MAX_RESULTS: usize = 500;
const MAX_FILE_CHARS: usize = 200_000;
const IGNORED: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".next",
    "dist",
    "build",
];

fn boundWorkspaceRoot() -> Result<PathBuf> {
    if let Some(path) = env::var_os("RELAY_WORKSPACE") {
        let root = PathBuf::from(path)
            .canonicalize()
            .context("invalid RELAY_WORKSPACE")?;
        if !root.is_dir() {
            bail!("RELAY_WORKSPACE must be a directory");
        }
        return Ok(root);
    }
    bail!(
        "Workspace binding required. Select a registered editor folder in Relay, or set RELAY_WORKSPACE explicitly."
    )
}

fn target(root: &Path, input: &str) -> Result<PathBuf> {
    let fullAccess = env::var("RELAY_ACCESS_MODE").as_deref() == Ok("full");
    targetWithAccess(root, input, fullAccess)
}

fn targetWithAccess(root: &Path, input: &str, fullAccess: bool) -> Result<PathBuf> {
    let path = Path::new(if input.is_empty() { "." } else { input });
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let mut ancestor = candidate.as_path();
    let mut missing = Vec::new();
    while !ancestor.exists() {
        missing.push(
            ancestor
                .file_name()
                .context("invalid workspace path")?
                .to_owned(),
        );
        ancestor = ancestor.parent().context("invalid workspace path")?;
    }
    let mut absolute = ancestor.canonicalize()?;
    for part in missing.into_iter().rev() {
        absolute.push(part);
    }
    if !fullAccess && !absolute.starts_with(root) {
        bail!("Path escapes workspace root: {input}");
    }
    Ok(absolute)
}
fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_owned()
        .ifEmpty(".")
}
trait IfEmpty {
    fn ifEmpty(self, fallback: &str) -> Self;
}
impl IfEmpty for String {
    fn ifEmpty(self, fallback: &str) -> Self {
        if self.is_empty() {
            fallback.into()
        } else {
            self
        }
    }
}
fn ignored(path: &Path) -> bool {
    path.components().any(|c| {
        let component = c.as_os_str().to_string_lossy();
        IGNORED
            .iter()
            .any(|ignored| component.eq_ignore_ascii_case(ignored))
    })
}
fn matcher(pattern: &str) -> Result<GlobMatcher> {
    Ok(Glob::new(pattern)?.compile_matcher())
}
fn read(path: &Path) -> Result<String> {
    let mut s =
        fs::read_to_string(path).with_context(|| format!("File not found: {}", path.display()))?;
    if s.len() > MAX_FILE_CHARS {
        let boundary = s
            .char_indices()
            .take_while(|(index, _)| *index <= MAX_FILE_CHARS)
            .last()
            .map(|(index, _)| index)
            .unwrap_or(0);
        s.truncate(boundary);
        s.push_str("\n[truncated]");
    }
    Ok(s)
}
#[path = "workspace/process-execution.rs"]
mod processExecution;
use processExecution::executeCommand;
async fn command(root: &Path, program: &str, args: &[String], timeout: u64) -> Result<String> {
    const ALLOWED_COMMANDS: &[&str] = &[
        "cargo", "go", "just", "make", "npm", "pnpm", "yarn", "bun", "git", "python", "python3",
    ];
    let fullAccess = env::var("RELAY_ACCESS_MODE").as_deref() == Ok("full");
    if !fullAccess && !ALLOWED_COMMANDS.contains(&program) {
        bail!(
            "Workspace mode blocks '{program}'. Full access permits any installed executable and toolchain. Allowed in Workspace mode: {}.",
            ALLOWED_COMMANDS.join(", ")
        );
    }
    if !fullAccess
        && matches!(program, "python" | "python3")
        && !(args.first().map(String::as_str) == Some("-m")
            && matches!(args.get(1).map(String::as_str), Some("pytest" | "unittest")))
    {
        bail!("Python is limited to '-m pytest' or '-m unittest' in workspace-safe mode.");
    }
    if !fullAccess
        && program == "git"
        && !matches!(
            args.first().map(String::as_str),
            Some("status" | "diff" | "log" | "branch")
        )
    {
        bail!("Only read-only git status, diff, log, and branch commands are allowed.");
    }
    let output = executeCommand(root, program, args, timeout).await?;
    let text = String::from_utf8_lossy(if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    })
    .trim()
    .to_owned();
    if !output.status.success() {
        bail!(
            "Command exited with status {}:\n{}",
            output.status,
            text.chars().take(MAX_FILE_CHARS).collect::<String>()
        );
    }
    Ok(if text.is_empty() {
        "(no output)".into()
    } else {
        text.chars().take(MAX_FILE_CHARS).collect()
    })
}

fn tools() -> Value {
    json!([
     {"name":"workspace.describe","description":"Get the active VS Code workspace name, path, and Git status.","inputSchema":{"type":"object","properties":{},"required":[]}},
     {"name":"project.describe","description":"Inspect common project manifests and package scripts.","inputSchema":{"type":"object","properties":{},"required":[]}},
     {"name":"workspace.list","description":"List files and folders in the workspace.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":[]}},
     {"name":"workspace.tree","description":"List a bounded tree of workspace files and folders.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"maxDepth":{"type":"integer","minimum":0,"maximum":8}},"required":[]}},
     {"name":"workspace.find","description":"Find workspace files by glob pattern.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"pattern":{"type":"string"}},"required":[]}},
     {"name":"workspace.search","description":"Search text in workspace files.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"query":{"type":"string"},"filePattern":{"type":"string"},"caseSensitive":{"type":"boolean"}},"required":["path","query"]}},
     {"name":"workspace.readText","description":"Read a UTF-8 text file in the workspace.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}},
     {"name":"workspace.readBatch","description":"Read up to 50 workspace files.","inputSchema":{"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"}}},"required":["paths"]}},
     {"name":"workspace.read","description":"Read a bounded line range from a workspace file.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"startLine":{"type":"integer"},"endLine":{"type":"integer"}},"required":["path"]}},
     {"name":"workspace.stat","description":"Get size, type, extension, and modification time for a workspace path.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}},
     {"name":"code.outline","description":"List class and function declarations from a source file.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}},
     {"name":"workspace.create","description":"Create a new file without overwriting an existing file.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path"]}},
     {"name":"workspace.write","description":"Write or replace a UTF-8 text file inside the workspace.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}},
     {"name":"workspace.replace","description":"Replace an exact text snippet; by default the snippet must be unique.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"oldText":{"type":"string"},"newText":{"type":"string"},"replaceAll":{"type":"boolean"}},"required":["path","oldText","newText"]}},
     {"name":"workspace.mkdir","description":"Create a directory inside the workspace.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}},
     {"name":"workspace.move","description":"Move a file inside the workspace without overwriting a destination.","inputSchema":{"type":"object","properties":{"source":{"type":"string"},"destination":{"type":"string"}},"required":["source","destination"]}},
     {"name":"workspace.copy","description":"Copy a file inside the workspace without overwriting a destination.","inputSchema":{"type":"object","properties":{"source":{"type":"string"},"destination":{"type":"string"}},"required":["source","destination"]}},
     {"name":"vcs.status","description":"Show the current Git branch and working-tree status.","inputSchema":{"type":"object","properties":{},"required":[]}},
     {"name":"vcs.diff","description":"Show unstaged Git changes, optionally for one workspace path.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":[]}},
     {"name":"vcs.log","description":"Show recent Git commits.","inputSchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":50}},"required":[]}},
     {"name":"vcs.branches","description":"List local Git branches.","inputSchema":{"type":"object","properties":{},"required":[]}},
     {"name":"process.run","description":"Run a developer process in the selected project. Workspace mode enforces an executable allowlist. Full access allows any executable, including an explicitly requested shell.","inputSchema":{"type":"object","properties":{"command":{"type":"string"},"args":{"type":"array","items":{"type":"string"}}},"required":["command"]}},
     {"name":"project.run","description":"Run a named safe script from package.json.","inputSchema":{"type":"object","properties":{"script":{"type":"string"}},"required":["script"]}},
     {"name":"project.test","description":"Run the workspace test script, pytest, .NET, or Cargo tests when configured.","inputSchema":{"type":"object","properties":{},"required":[]}}
    ])
}

async fn call(name: &str, a: &Value) -> Result<Value> {
    let root = boundWorkspaceRoot()?;
    let s = |k: &str| a[k].as_str().unwrap_or("");
    match name {
        "workspace.describe" => Ok(
            json!({"name":root.file_name().unwrap_or_default().to_string_lossy(),"path":root,"isGitRepository":root.join(".git").exists()}),
        ),
        "project.describe" => {
            let mut manifests = Vec::new();
            for n in [
                "package.json",
                "pyproject.toml",
                "Cargo.toml",
                "go.mod",
                "pom.xml",
            ] {
                let p = root.join(n);
                if p.is_file() {
                    let mut e = json!({"path":n});
                    if n == "package.json"
                        && let Ok(v) = serde_json::from_str::<Value>(&fs::read_to_string(&p)?)
                    {
                        e["name"] = v["name"].clone();
                        e["scripts"] = v["scripts"].clone();
                    }
                    manifests.push(e)
                }
            }
            Ok(
                json!({"workspace":root.file_name().unwrap_or_default().to_string_lossy(),"manifests":manifests}),
            )
        }
        "workspace.list" => {
            let p = target(&root, s("path"))?;
            if !p.is_dir() {
                bail!("Not a directory: {}", s("path"))
            };
            let mut v=fs::read_dir(p)?.filter_map(Result::ok).map(|e|{let p=e.path();json!({"name":e.file_name().to_string_lossy(),"path":rel(&root,&p),"type":if p.is_dir(){"directory"}else{"file"}})}).collect::<Vec<_>>();
            v.sort_by_key(|x| x["path"].as_str().unwrap_or("").to_lowercase());
            Ok(json!(v))
        }
        "workspace.tree" => {
            let p = target(&root, s("path"))?;
            let depth = a["maxDepth"].as_u64().unwrap_or(3).min(8) as usize;
            let mut v = Vec::new();
            for e in WalkDir::new(&p)
                .min_depth(1)
                .max_depth(depth + 1)
                .into_iter()
                .filter_map(Result::ok)
            {
                if ignored(e.path()) {
                    continue;
                }
                v.push(json!({"path":rel(&root,e.path()),"type":if e.file_type().is_dir(){"directory"}else{"file"}}));
                if v.len() >= MAX_RESULTS {
                    break;
                }
            }
            Ok(json!(v))
        }
        "workspace.find" => {
            let base = target(&root, s("path"))?;
            let m = matcher(if s("pattern").is_empty() {
                "*"
            } else {
                s("pattern")
            })?;
            let v = WalkDir::new(base)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file() && !ignored(e.path()))
                .filter(|e| m.is_match(e.file_name()) || m.is_match(e.path()))
                .take(MAX_RESULTS)
                .map(|e| rel(&root, e.path()))
                .collect::<Vec<_>>();
            Ok(json!(v))
        }
        "workspace.search" => {
            let q = s("query");
            if q.is_empty() {
                bail!("Search query cannot be empty.")
            }
            let p = target(&root, s("path"))?;
            let m = matcher(if s("filePattern").is_empty() {
                "*"
            } else {
                s("filePattern")
            })?;
            let sensitive = a["caseSensitive"].as_bool().unwrap_or(false);
            let needle = if sensitive {
                q.to_owned()
            } else {
                q.to_lowercase()
            };
            let files: Vec<PathBuf> = if p.is_file() {
                vec![p]
            } else {
                WalkDir::new(p)
                    .into_iter()
                    .filter_map(Result::ok)
                    .filter(|e| e.file_type().is_file() && !ignored(e.path()))
                    .map(|e| e.into_path())
                    .collect()
            };
            let mut v = Vec::new();
            for f in files {
                if !m.is_match(f.file_name().unwrap_or_default()) {
                    continue;
                }
                if let Ok(text) = fs::read_to_string(&f) {
                    for (i, line) in text.lines().enumerate() {
                        let h = if sensitive {
                            line.to_owned()
                        } else {
                            line.to_lowercase()
                        };
                        if h.contains(&needle) {
                            v.push(json!({"path":rel(&root,&f),"line":i+1,"text":line.chars().take(500).collect::<String>()}));
                            if v.len() >= MAX_RESULTS {
                                return Ok(json!(v));
                            }
                        }
                    }
                }
            }
            Ok(json!(v))
        }
        "workspace.readText" => Ok(json!(read(&target(&root, s("path"))?)?)),
        "workspace.readBatch" => {
            let ps = a["paths"]
                .as_array()
                .ok_or_else(|| anyhow!("paths must be an array"))?;
            if ps.len() > 50 {
                bail!("Read at most 50 files per request.")
            }
            Ok(json!(
                ps.iter()
                    .map(|p| {
                        let path = p.as_str().unwrap_or("");
                        Ok(json!({"path":path,"content":read(&target(&root,path)?)?}))
                    })
                    .collect::<Result<Vec<_>>>()?
            ))
        }
        "workspace.read" => {
            let start = a["startLine"].as_u64().unwrap_or(1) as usize;
            let end = a["endLine"].as_u64().unwrap_or(200) as usize;
            if start < 1 || end < start || end - start > 999 {
                bail!("Invalid line range.")
            }
            let file = fs::File::open(target(&root, s("path"))?)?;
            let reader = io::BufReader::new(file);
            let selected = io::BufRead::lines(reader)
                .enumerate()
                .skip(start - 1)
                .take(end - start + 1)
                .map(|(i, line)| line.map(|text| format!("{}: {}", i + 1, text)))
                .collect::<io::Result<Vec<_>>>()?;
            Ok(json!(selected.join("\n")))
        }
        "workspace.stat" => {
            let p = target(&root, s("path"))?;
            let meta = fs::metadata(&p)?;
            let modified = meta.modified()?.duration_since(UNIX_EPOCH)?.as_secs_f64();
            Ok(
                json!({"path":rel(&root,&p),"type":if meta.is_dir(){"directory"}else{"file"},"sizeBytes":meta.len(),"modified":modified,"suffix":p.extension().unwrap_or_default().to_string_lossy()}),
            )
        }
        "code.outline" => {
            let re = Regex::new(
                r"^\s*(?:(?:async|export)\s+)*(?:def|class|function)\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=",
            )?;
            Ok(json!(read(&target(&root,s("path"))?)?.lines().enumerate().filter_map(|(i,l)|re.captures(l).map(|c|json!({"name":c.get(1).or_else(||c.get(2)).unwrap().as_str(),"line":i+1}))).take(MAX_RESULTS).collect::<Vec<_>>()))
        }
        "workspace.create" => {
            let p = target(&root, s("path"))?;
            fs::create_dir_all(p.parent().unwrap())?;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&p)?
                .write_all(s("content").as_bytes())?;
            Ok(json!(format!("Created {}", rel(&root, &p))))
        }
        "workspace.write" => {
            let p = target(&root, s("path"))?;
            fs::create_dir_all(p.parent().unwrap())?;
            fs::write(&p, s("content"))?;
            Ok(json!(format!("Saved {}", rel(&root, &p))))
        }
        "workspace.replace" => {
            let p = target(&root, s("path"))?;
            let old = s("oldText");
            if old.is_empty() {
                bail!("oldText cannot be empty.")
            }
            let text = fs::read_to_string(&p)?;
            let count = text.matches(old).count();
            if count == 0 {
                bail!("The exact oldText was not found.")
            }
            if !a["replaceAll"].as_bool().unwrap_or(false) && count != 1 {
                bail!("oldText occurs {count} times; provide a unique snippet or set replaceAll.")
            }
            let updated = if a["replaceAll"].as_bool().unwrap_or(false) {
                text.replace(old, s("newText"))
            } else {
                text.replacen(old, s("newText"), 1)
            };
            fs::write(&p, updated)?;
            Ok(json!(format!(
                "Updated {} ({} replacement(s))",
                rel(&root, &p),
                if a["replaceAll"].as_bool().unwrap_or(false) {
                    count
                } else {
                    1
                }
            )))
        }
        "workspace.mkdir" => {
            let p = target(&root, s("path"))?;
            fs::create_dir_all(&p)?;
            Ok(json!(format!("Directory ready: {}", rel(&root, &p))))
        }
        "workspace.move" | "workspace.copy" => {
            let from = target(&root, s("source"))?;
            let to = target(&root, s("destination"))?;
            if to.exists() {
                bail!("Destination already exists: {}", s("destination"))
            }
            fs::create_dir_all(to.parent().unwrap())?;
            if name == "workspace.move" {
                fs::rename(&from, &to)?
            } else {
                fs::copy(&from, &to)?;
            }
            Ok(json!(format!(
                "{} {} to {}",
                if name == "workspace.move" {
                    "Moved"
                } else {
                    "Copied"
                },
                rel(&root, &from),
                rel(&root, &to)
            )))
        }
        "vcs.status" => Ok(json!(
            command(
                &root,
                "git",
                &["status".into(), "--short".into(), "--branch".into()],
                30
            )
            .await?
        )),
        "vcs.diff" => {
            let mut x = vec!["diff".into(), "--".into()];
            if !s("path").is_empty() {
                x.push(rel(&root, &target(&root, s("path"))?))
            }
            Ok(json!(command(&root, "git", &x, 30).await?))
        }
        "vcs.log" => {
            let n = a["limit"].as_u64().unwrap_or(10);
            if !(1..=50).contains(&n) {
                bail!("limit must be between 1 and 50.")
            }
            Ok(json!(
                command(
                    &root,
                    "git",
                    &[
                        "log".into(),
                        format!("-{n}"),
                        "--oneline".into(),
                        "--decorate".into(),
                    ],
                    30
                )
                .await?
            ))
        }
        "vcs.branches" => Ok(json!(
            command(
                &root,
                "git",
                &["branch".into(), "--format=%(refname:short)".into()],
                30
            )
            .await?
        )),
        "process.run" => {
            let cmd = s("command");
            if cmd.is_empty() {
                bail!("Command cannot be empty.")
            }
            let args: Vec<String> = match a.get("args") {
                Some(Value::Array(values)) => values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(String::from)
                            .context("Every process argument must be a string")
                    })
                    .collect::<Result<_>>()?,
                None | Some(Value::Null) => Vec::new(),
                _ => bail!("Process arguments must be an array of strings"),
            };
            Ok(json!(
                command(
                    &root,
                    cmd,
                    &args,
                    a["timeout"].as_u64().unwrap_or(30).clamp(1, 300)
                )
                .await?
            ))
        }
        "project.run" => {
            let script = s("script");
            let safe = HashSet::from(["build", "check", "format", "lint", "test", "typecheck"]);
            if !safe.contains(script) {
                bail!("Script must be one of: build, check, format, lint, test, typecheck.")
            }
            let package: Value = serde_json::from_str(
                &fs::read_to_string(root.join("package.json"))
                    .context("No package.json found in the workspace root.")?,
            )?;
            if package["scripts"][script].is_null() {
                bail!("package.json does not define the '{script}' script.")
            }
            let manager = if root.join("pnpm-lock.yaml").exists() {
                "pnpm"
            } else if root.join("yarn.lock").exists() {
                "yarn"
            } else if root.join("bun.lock").exists() || root.join("bun.lockb").exists() {
                "bun"
            } else {
                "npm"
            };
            Ok(json!(
                command(&root, manager, &["run".into(), script.into()], 300).await?
            ))
        }
        "project.test" => {
            if root.join("package.json").is_file() {
                return Box::pin(call("project.run", &json!({"script":"test"}))).await;
            }
            let (p, a) = if root.join("Cargo.toml").is_file() {
                ("cargo", vec!["test".into()])
            } else if root.join("pyproject.toml").is_file() || root.join("pytest.ini").is_file() {
                (
                    if cfg!(windows) { "python" } else { "python3" },
                    vec!["-m".into(), "pytest".into()],
                )
            } else {
                bail!("No supported test setup found.")
            };
            Ok(json!(command(&root, p, &a, 300).await?))
        }
        _ => bail!("Unknown tool: {name}"),
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let (requests, mut incoming) = tokio::sync::mpsc::channel(16);
    let (cancellation, mut cancelled) = tokio::sync::watch::channel(false);
    let readerCancellation = cancellation.clone();
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(request) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if request["method"] == "notifications/cancelled" {
                readerCancellation.send_replace(true);
                break;
            }
            if requests.send(request).await.is_err() {
                break;
            }
        }
    });
    let mut out = tokio::io::stdout();
    while let Some(r) = incoming.recv().await {
        let id = r["id"].clone();
        let response = match r["method"].as_str() {
            Some("initialize") => {
                json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"relay-workspace","version":env!("CARGO_PKG_VERSION")}}})
            }
            Some("ping") => json!({"jsonrpc":"2.0","id":id,"result":{}}),
            Some("tools/list") => {
                json!({"jsonrpc":"2.0","id":id,"result":{"tools":tools()}})
            }
            Some("tools/call") => match tokio::select! {
                result = call(r["params"]["name"].as_str().unwrap_or(""), &r["params"]["arguments"]) => result,
                _ = cancelled.changed() => return Ok(()),
            } {
                Ok(v) => {
                    json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":if v.is_string(){v.as_str().unwrap().to_owned()}else{v.to_string()}}],"structuredContent":{"result":v}}})
                }
                Err(e) => {
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":e.to_string()}})
                }
            },
            Some("notifications/initialized") => continue,
            _ => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
            }
        };
        out.write_all(serde_json::to_string(&response)?.as_bytes())
            .await?;
        out.write_all(b"\n").await?;
        out.flush().await?;
    }
    Ok(())
}

#[cfg(test)]
mod regressionTests {
    use super::*;

    #[test]
    fn truncationPreservesUtf8AndIgnoredPathsAreCaseInsensitive() {
        let path = env::temp_dir().join(format!("relay-utf8-{}", std::process::id()));
        fs::write(&path, format!("{}😀世界", "a".repeat(199_999))).unwrap();
        let text = read(&path).unwrap();
        assert!(text.ends_with("[truncated]"));
        assert_eq!(text.split('\n').next().unwrap().len(), 199_999);
        fs::remove_file(path).unwrap();
        assert!(ignored(Path::new("src/Node_Modules/pkg")));
        assert!(ignored(Path::new("Dist/index.js")));
        let root = env::current_dir().unwrap().canonicalize().unwrap();
        let outside = "../relay-nonexistent-escape/new.txt";
        assert!(targetWithAccess(&root, outside, false).is_err());
        assert!(targetWithAccess(&root, outside, true).is_ok());
    }

    #[tokio::test]
    async fn timeoutKillsDescendantAndDrainsLargeOutput() {
        let root = env::temp_dir().join(format!("relay-timeout-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let program = if cfg!(windows) { "python" } else { "python3" };
        let code = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c',\"import time,pathlib; time.sleep(2); pathlib.Path('escaped').write_text('bad')\"]); print(p.pid,flush=True); time.sleep(60)";
        let result = executeCommand(&root, program, &["-c".into(), code.into()], 1).await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("timed out after 1s")
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(
            !root.join("escaped").exists(),
            "descendant survived timeout"
        );
        let result = executeCommand(
            &root,
            program,
            &["-c".into(), "print('x' * 1000000)".into()],
            5,
        )
        .await
        .unwrap();
        assert_eq!(result.stdout.len(), MAX_FILE_CHARS);
        fs::remove_dir_all(root).unwrap();
    }
}
