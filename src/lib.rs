#![allow(non_snake_case)]
use anyhow::{Context, Result};
use std::{env, fs, path::PathBuf};

pub fn platformCommand(command: &str) -> String {
    if cfg!(windows) && matches!(command, "npm" | "npx" | "pnpm" | "yarn") {
        format!("{command}.cmd")
    } else {
        command.into()
    }
}

pub fn configPath() -> Result<PathBuf> {
    if let Some(path) = env::var_os("RELAY_CONFIG") {
        return Ok(PathBuf::from(path));
    }
    let local = env::current_dir()?.join("config.json");
    if local.is_file() {
        return Ok(local);
    }
    let base = if cfg!(windows) {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .context("APPDATA unavailable")?
    } else {
        env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or(
            dirs::home_dir()
                .context("home directory unavailable")?
                .join(".config"),
        )
    };
    Ok(base.join("relay/config.json"))
}

pub fn ensureConfig() -> Result<PathBuf> {
    let path = configPath()?;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(b"{\"mcpServers\":{}}\n")?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    Ok(path)
}
