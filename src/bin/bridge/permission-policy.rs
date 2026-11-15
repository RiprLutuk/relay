use anyhow::{Result, bail};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AccessMode {
    Observe,
    Supervised,
    Autonomous,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Decision {
    Allow,
    ApprovalRequired,
    Deny,
}

impl AccessMode {
    pub(super) fn asStr(self) -> &'static str {
        match self {
            Self::Observe => "observe",
            Self::Supervised => "supervised",
            Self::Autonomous => "autonomous",
        }
    }
    pub(super) fn parse(value: &str) -> Result<Self> {
        match value {
            "observe" => Ok(Self::Observe),
            "supervised" | "workspace" => Ok(Self::Supervised),
            "autonomous" | "full" => Ok(Self::Autonomous),
            _ => bail!("Invalid access mode"),
        }
    }

    pub(super) fn decide(self, tool: &str) -> Decision {
        let readOnly = matches!(
            tool,
            "workspace.describe"
                | "project.describe"
                | "workspace.list"
                | "workspace.tree"
                | "workspace.find"
                | "workspace.search"
                | "workspace.readText"
                | "workspace.readBatch"
                | "workspace.read"
                | "workspace.stat"
                | "code.outline"
                | "vcs.status"
                | "vcs.diff"
                | "vcs.log"
                | "vcs.branches"
        );
        if readOnly {
            return Decision::Allow;
        }
        let workspaceSafe = matches!(
            tool,
            "workspace.create"
                | "workspace.write"
                | "workspace.replace"
                | "workspace.mkdir"
                | "workspace.copy"
                | "project.run"
                | "project.test"
        );
        match self {
            Self::Observe => Decision::Deny,
            Self::Supervised if workspaceSafe => Decision::Allow,
            Self::Supervised => Decision::ApprovalRequired,
            Self::Autonomous => Decision::Allow,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modesFailClosedAndLegacyNamesMigrate() {
        assert_eq!(
            AccessMode::parse("workspace").unwrap(),
            AccessMode::Supervised
        );
        assert_eq!(AccessMode::parse("full").unwrap(), AccessMode::Autonomous);
        assert!(AccessMode::parse("unknown").is_err());
        assert_eq!(
            AccessMode::Observe.decide("workspace.readText"),
            Decision::Allow
        );
        assert_eq!(
            AccessMode::Observe.decide("workspace.write"),
            Decision::Deny
        );
        assert_eq!(
            AccessMode::Supervised.decide("workspace.write"),
            Decision::Allow
        );
        assert_eq!(
            AccessMode::Supervised.decide("project.test"),
            Decision::Allow
        );
        assert_eq!(
            AccessMode::Supervised.decide("process.run"),
            Decision::ApprovalRequired
        );
        assert_eq!(
            AccessMode::Autonomous.decide("process.run"),
            Decision::Allow
        );
    }
}
