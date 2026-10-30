#![allow(non_snake_case)]
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    env, fs,
    path::PathBuf,
    process::{Command, Stdio},
};

fn siblingBinary(name: &str) -> Result<PathBuf> {
    let executable = env::current_exe().context("locating relayctl")?;
    Ok(executable
        .parent()
        .context("locating relayctl directory")?
        .join(format!("{name}{}", env::consts::EXE_SUFFIX)))
}

fn usage() {
    eprintln!(
        "Relay control plane\n\nUSAGE:\n  relayctl start [--port PORT]\n  relayctl check\n  relayctl token\n  relayctl server list\n  relayctl server add <id> <command> [args...]\n  relayctl server remove <id>\n  relayctl version"
    );
}

fn configPath() -> Result<PathBuf> {
    relay::ensureConfig()
}

fn validServerId(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn loadConfig() -> Result<Value> {
    let path = configPath()?;
    let mut config = if path.exists() {
        serde_json::from_str(&fs::read_to_string(&path)?).context("invalid config.json")?
    } else {
        json!({})
    };
    if !config["mcpServers"].is_object() {
        config["mcpServers"] = json!({});
    }
    Ok(config)
}

fn saveConfig(config: &Value) -> Result<()> {
    let path = configPath()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        format!("{}\n", serde_json::to_string_pretty(config)?),
    )?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn serverCommand(arguments: impl Iterator<Item = String>) -> Result<()> {
    let mut args = arguments;
    match args.next().as_deref() {
        Some("list") => {
            let config = loadConfig()?;
            let servers = config["mcpServers"]
                .as_object()
                .context("mcpServers must be an object")?;
            if servers.is_empty() {
                println!("No custom servers. Relay supplies VS Code automatically.");
            }
            for (id, server) in servers {
                println!(
                    "{id}\t{}",
                    server["command"]
                        .as_str()
                        .unwrap_or("invalid configuration")
                );
            }
            Ok(())
        }
        Some("add") => {
            let id = args.next().context("server add requires an id")?;
            let command = args.next().context("server add requires a command")?;
            if !validServerId(&id) {
                bail!("Server id must use only letters, digits, '.', '_' or '-'.");
            }
            if matches!(id.as_str(), "workspace" | "vscode") {
                bail!("The workspace server is managed by Relay; use a different server id.");
            }
            let rest = args.collect::<Vec<_>>();
            let mut config = loadConfig()?;
            config["mcpServers"][&id] = json!({"command": command, "args": rest, "env": {}});
            saveConfig(&config)?;
            println!("Added MCP server '{id}'. Restart Relay to load it.");
            Ok(())
        }
        Some("remove") => {
            let id = args.next().context("server remove requires an id")?;
            if id == "workspace" {
                bail!("The workspace server is managed by Relay and cannot be removed.");
            }
            let mut config = loadConfig()?;
            let Some(servers) = config["mcpServers"].as_object_mut() else {
                bail!("mcpServers must be an object");
            };
            if servers.remove(&id).is_none() {
                bail!("No MCP server named '{id}'.");
            }
            saveConfig(&config)?;
            println!("Removed MCP server '{id}'. Restart Relay to apply the change.");
            Ok(())
        }
        _ => {
            usage();
            bail!("Expected: relayctl server list|add|remove")
        }
    }
}

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("start") => {
            let mut port = None;
            while let Some(argument) = args.next() {
                match argument.as_str() {
                    "--port" => port = Some(args.next().context("--port requires a value")?),
                    "--help" | "-h" => {
                        usage();
                        return Ok(());
                    }
                    _ => bail!("Unknown option: {argument}"),
                }
            }
            let bridge = siblingBinary("relay-bridge")?;
            if !bridge.is_file() {
                bail!(
                    "{} is missing. Build Relay with `cargo build --release`.",
                    bridge.display()
                );
            }
            let mut command = Command::new(bridge);
            command
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
            if let Some(port) = port {
                command.env("RELAY_BRIDGE_PORT", port);
            }
            let status = command.status().context("starting Relay bridge")?;
            if status.success() {
                Ok(())
            } else {
                bail!("Relay bridge exited with {status}")
            }
        }
        Some("check") => {
            let bridge = siblingBinary("relay-bridge")?;
            let mcp = siblingBinary("relay-workspace")?;
            println!("Relay control plane");
            println!(
                "  bridge: {}",
                if bridge.is_file() { "ready" } else { "missing" }
            );
            println!(
                "  workspace MCP: {}",
                if mcp.is_file() { "ready" } else { "missing" }
            );
            println!("  workspace: {}", env::current_dir()?.display());
            if bridge.is_file() && mcp.is_file() {
                Ok(())
            } else {
                bail!("Build Relay with `cargo build --release`.")
            }
        }
        Some("server") => serverCommand(args),
        Some("token") => {
            let path = env::var_os("RELAY_STATE_DIR")
                .map(PathBuf::from)
                .unwrap_or(
                    dirs::home_dir()
                        .context("locating home directory")?
                        .join(".relay"),
                )
                .join("bridge-token");
            print!(
                "{}",
                fs::read_to_string(&path).with_context(|| format!(
                    "token unavailable; start Relay once first ({})",
                    path.display()
                ))?
            );
            Ok(())
        }
        Some("version") => {
            println!("Relay {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("help") | Some("--help") | Some("-h") | None => {
            usage();
            Ok(())
        }
        Some(command) => {
            usage();
            bail!("Unknown command: {command}")
        }
    }
}
