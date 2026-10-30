#![allow(non_snake_case)]
use super::*;

#[cfg(unix)]
struct ProcessGroup(u32);

#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
fn commandJob(child: &tokio::process::Child) -> Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::*;

    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() {
            return Err(io::Error::last_os_error().into());
        }
        let job = OwnedHandle::from_raw_handle(raw);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(
                job.as_raw_handle(),
                child
                    .raw_handle()
                    .context("child process handle unavailable")?,
            ) == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        Ok(job)
    }
}

pub(super) async fn executeCommand(
    root: &Path,
    program: &str,
    args: &[String],
    seconds: u64,
) -> Result<std::process::Output> {
    use tokio::io::AsyncReadExt;
    let mut cmd = tokio::process::Command::new(relay::platformCommand(program));
    cmd.args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    let mut child = cmd.spawn().with_context(|| format!("running {program}"))?;
    #[cfg(windows)]
    let job = commandJob(&child)?;
    #[cfg(unix)]
    let pid = child.id().context("child process has no PID")?;
    #[cfg(unix)]
    let processGroup = ProcessGroup(pid);
    async fn drain(mut pipe: impl tokio::io::AsyncRead + Unpin) -> io::Result<Vec<u8>> {
        let mut retained = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = pipe.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            let keep = n.min(MAX_FILE_CHARS.saturating_sub(retained.len()));
            retained.extend_from_slice(&buf[..keep]);
        }
        Ok(retained)
    }
    let stdout = tokio::spawn(drain(child.stdout.take().context("stdout unavailable")?));
    let stderr = tokio::spawn(drain(child.stderr.take().context("stderr unavailable")?));
    let work = async {
        let status = child.wait().await?;
        let out = stdout.await??;
        let err = stderr.await??;
        Ok::<_, anyhow::Error>(std::process::Output {
            status,
            stdout: out,
            stderr: err,
        })
    };
    let outcome = tokio::time::timeout(Duration::from_secs(seconds), work).await;
    #[cfg(unix)]
    drop(processGroup);
    match outcome {
        Ok(result) => result,
        Err(_) => {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            drop(job);
            let _ = child.kill().await;
            let _ = child.wait().await;
            bail!("Command timed out after {seconds}s")
        }
    }
}
