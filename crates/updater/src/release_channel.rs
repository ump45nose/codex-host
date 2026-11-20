//! Vincent fork release channel.
//!
//! Fork builds are versioned `X.Y.Z-vincent.N` and are never published to the npm
//! registry; they are attached as npm tarballs to the GitHub Release `vX.Y.Z-vincent.N`
//! of the release repository. The repository defaults to the fork and follows
//! `CODEXHOST_UPDATE_REPOSITORY=owner/repo`, the same variable the TypeScript update
//! check reads (this helper inherits the caller's environment).

pub(crate) const DEFAULT_RELEASE_REPOSITORY: &str = "ump45nose/codex-host";
pub(crate) const UPDATE_REPOSITORY_ENV: &str = "CODEXHOST_UPDATE_REPOSITORY";
const RELEASE_CHANNEL: &str = "vincent";
const NPM_PACKAGE_NAME: &str = "@codexhost/cli";

/// `X.Y.Z-vincent.N`, without build metadata.
pub(crate) fn is_channel_version(version: &str) -> bool {
    let Some((core, prerelease)) = version.split_once('-') else {
        return false;
    };
    let numbers: Vec<_> = core.split('.').collect();
    let numeric = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && !(part.len() > 1 && part.starts_with('0'))
    };
    numbers.len() == 3
        && numbers.iter().all(|part| numeric(part))
        && prerelease
            .strip_prefix(RELEASE_CHANNEL)
            .and_then(|rest| rest.strip_prefix('.'))
            .is_some_and(numeric)
}

pub(crate) fn validate_repository(value: &str) -> Result<String, String> {
    let value = value.trim();
    let valid = value.split_once('/').is_some_and(|(owner, name)| {
        !owner.is_empty()
            && owner.len() <= 39
            && !owner.starts_with('-')
            && owner
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && !name.is_empty()
            && name.len() <= 100
            && name != "."
            && name != ".."
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    });
    if valid {
        Ok(value.to_owned())
    } else {
        Err(format!("{UPDATE_REPOSITORY_ENV} must be owner/repo"))
    }
}

pub(crate) fn repository_from(configured: Option<&str>) -> Result<String, String> {
    match configured {
        Some(value) if !value.trim().is_empty() => validate_repository(value),
        _ => Ok(DEFAULT_RELEASE_REPOSITORY.to_owned()),
    }
}

pub(crate) fn release_repository() -> Result<String, String> {
    repository_from(std::env::var(UPDATE_REPOSITORY_ENV).ok().as_deref())
}

/// Release target of an npm platform package directory name (`cli-darwin-arm64`, ...).
pub(crate) fn platform_package_target(name: &str) -> Option<&'static str> {
    match name {
        "cli-darwin-arm64" => Some("macos-arm64"),
        "cli-darwin-x64" => Some("macos-x64"),
        "cli-linux-arm64" => Some("linux-arm64"),
        "cli-linux-x64" => Some("linux-x64"),
        "cli-win32-x64" => Some("windows-x64"),
        "cli-win32-arm64" => Some("windows-arm64"),
        _ => None,
    }
}

/// What `npm install` receives for the meta package (`platform == None`) or one
/// platform package: a registry spec for upstream versions, the Release tarball URL
/// for channel versions.
pub(crate) fn npm_package_spec(repository: &str, version: &str, platform: Option<&str>) -> String {
    if !is_channel_version(version) {
        return match platform {
            None => format!("{NPM_PACKAGE_NAME}@{version}"),
            Some(target) => {
                let name = match target {
                    "macos-arm64" => "cli-darwin-arm64",
                    "macos-x64" => "cli-darwin-x64",
                    "linux-arm64" => "cli-linux-arm64",
                    "linux-x64" => "cli-linux-x64",
                    "windows-x64" => "cli-win32-x64",
                    _ => "cli-win32-arm64",
                };
                format!("@codexhost/{name}@{version}")
            }
        };
    }
    let suffix = platform
        .map(|target| format!("-{target}"))
        .unwrap_or_default();
    format!(
        "https://github.com/{repository}/releases/download/v{version}/codexhost-cli-{version}{suffix}.tgz"
    )
}

pub(crate) fn is_tarball_spec(spec: &str) -> bool {
    spec.starts_with("https://")
}

/// npm arguments that fail when the spec cannot be fetched, without installing.
/// `npm view` only understands registry specs; `npm pack --dry-run` resolves a
/// tarball URL and writes nothing.
pub(crate) fn npm_availability_args(spec: &str) -> Vec<String> {
    let mut arguments = if is_tarball_spec(spec) {
        vec!["pack".to_owned(), "--dry-run".to_owned(), spec.to_owned()]
    } else {
        vec!["view".to_owned(), spec.to_owned(), "version".to_owned()]
    };
    arguments.extend([
        "--fetch-retries=0".to_owned(),
        "--fetch-timeout=30000".to_owned(),
    ]);
    arguments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_channel_versions() {
        assert!(is_channel_version("0.17.2-vincent.1"));
        assert!(is_channel_version("1.0.0-vincent.12"));
        for version in [
            "0.17.2",
            "0.17.2-vincent",
            "0.17.2-vincent.",
            "0.17.2-vincent.01",
            "0.17.2-vincent.1.2",
            "0.17.2-rc.1",
            "0.17-vincent.1",
            "0.17.2-vincent.1+x",
        ] {
            assert!(!is_channel_version(version), "{version}");
        }
    }

    #[test]
    fn resolves_the_release_repository() {
        assert_eq!(repository_from(None).unwrap(), "ump45nose/codex-host");
        assert_eq!(repository_from(Some("  ")).unwrap(), "ump45nose/codex-host");
        assert_eq!(
            repository_from(Some("BytePioneer-AI/codex-host")).unwrap(),
            "BytePioneer-AI/codex-host"
        );
        for invalid in [
            "nope",
            "a/b/c",
            "a/..",
            "-a/b",
            "a/b c",
            "a/b;rm",
            "https://x/y",
        ] {
            assert!(repository_from(Some(invalid)).is_err(), "{invalid}");
        }
    }

    #[test]
    fn maps_versions_to_npm_specs() {
        let repository = "ump45nose/codex-host";
        assert_eq!(
            npm_package_spec(repository, "0.17.2", None),
            "@codexhost/cli@0.17.2"
        );
        assert_eq!(
            npm_package_spec(repository, "0.17.2", Some("linux-x64")),
            "@codexhost/cli-linux-x64@0.17.2"
        );
        assert_eq!(
            npm_package_spec(repository, "0.17.2-vincent.1", None),
            "https://github.com/ump45nose/codex-host/releases/download/v0.17.2-vincent.1/codexhost-cli-0.17.2-vincent.1.tgz"
        );
        assert_eq!(
            npm_package_spec(repository, "0.17.2-vincent.1", Some("macos-arm64")),
            "https://github.com/ump45nose/codex-host/releases/download/v0.17.2-vincent.1/codexhost-cli-0.17.2-vincent.1-macos-arm64.tgz"
        );
        assert_eq!(platform_package_target("cli-darwin-x64"), Some("macos-x64"));
        assert_eq!(platform_package_target("cli-linux-x64"), Some("linux-x64"));
        assert_eq!(platform_package_target("cli"), None);
    }

    #[test]
    fn checks_tarballs_without_the_registry_view() {
        assert_eq!(
            npm_availability_args("@codexhost/cli@1.2.3"),
            [
                "view",
                "@codexhost/cli@1.2.3",
                "version",
                "--fetch-retries=0",
                "--fetch-timeout=30000"
            ]
        );
        assert_eq!(
            npm_availability_args("https://github.com/o/r/releases/download/v1-x/a.tgz"),
            [
                "pack",
                "--dry-run",
                "https://github.com/o/r/releases/download/v1-x/a.tgz",
                "--fetch-retries=0",
                "--fetch-timeout=30000"
            ]
        );
    }
}
