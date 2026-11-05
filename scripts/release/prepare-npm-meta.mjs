import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  NPM_PACKAGE_DESCRIPTION,
  NPM_NODE_ENGINE,
  NPM_NODE_REQUIREMENT,
  NPM_PACKAGE_NAME,
  NPM_PLATFORM_PACKAGE_NAMES,
  createNpmBinLauncherSource,
  packNpmPackage,
  resolveNpmPackageVersion,
} from "./prepare-npm.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export function expectedNpmMetaPackagePaths() {
  return ["README.md", "bin/codexhost.js", "package.json"];
}

/**
 * Platform dependency specs. Registry releases pin each platform package to the same
 * version. Fork releases (`platformBaseUrl`) are not on the registry, so each listed
 * platform package points at its tarball attached to the GitHub Release instead; npm
 * still skips the optional packages whose os/cpu do not match.
 */
export function npmMetaOptionalDependencies({ version, platformBaseUrl, platformTargets }) {
  if (platformBaseUrl === undefined) {
    return Object.fromEntries(
      Object.values(NPM_PLATFORM_PACKAGE_NAMES).map((packageName) => [packageName, version]),
    );
  }
  const base = new URL(platformBaseUrl);
  if (base.protocol !== "https:" || base.search || base.hash || base.username || base.password) {
    throw new Error("npm meta platform base URL must be a plain https URL");
  }
  const targets = platformTargets ?? Object.keys(NPM_PLATFORM_PACKAGE_NAMES);
  if (targets.length === 0) throw new Error("npm meta package needs at least one platform target");
  const prefix = base.href.endsWith("/") ? base.href : `${base.href}/`;
  return Object.fromEntries(
    targets.map((target) => {
      const packageName = NPM_PLATFORM_PACKAGE_NAMES[target];
      if (!packageName) throw new Error(`unknown npm platform target: ${target}`);
      return [packageName, `${prefix}codexhost-cli-${version}-${target}.tgz`];
    }),
  );
}

export function createNpmMetaPackageManifest({ version, platformBaseUrl, platformTargets }) {
  return {
    name: NPM_PACKAGE_NAME,
    version,
    description: NPM_PACKAGE_DESCRIPTION,
    type: "module",
    bin: { codexhost: "bin/codexhost.js" },
    files: ["bin/**", "README.md"],
    engines: { node: NPM_NODE_ENGINE },
    optionalDependencies: npmMetaOptionalDependencies({
      version,
      platformBaseUrl,
      platformTargets,
    }),
    keywords: ["codex", "codexhost", "pi", "claude-code", "agent", "harness"],
    repository: {
      type: "git",
      url: "git+https://github.com/BytePioneer-AI/codex-host.git",
    },
    bugs: { url: "https://github.com/BytePioneer-AI/codex-host/issues" },
    homepage: "https://github.com/BytePioneer-AI/codex-host#readme",
    publishConfig: { access: "public" },
  };
}

export function createNpmMetaReadme({ version }) {
  const installCommand = version.includes("-vincent.")
    ? `npm install -g https://github.com/ump45nose/codex-host/releases/download/v${version}/codexhost-cli.tgz`
    : `npm install -g ${NPM_PACKAGE_NAME}@${version}`;
  return `# ${NPM_PACKAGE_NAME}

${NPM_PACKAGE_DESCRIPTION}

## Install

\`\`\`bash
${installCommand}
\`\`\`

npm automatically installs the matching macOS, Windows, or Linux platform package. ${NPM_NODE_REQUIREMENT} and the official ChatGPT/Codex Desktop are required.

## Usage

\`\`\`bash
codexhost --version
codexhost
codexhost remote install
codexhost remote status
\`\`\`

The \`codexhost\` command starts Codex Desktop. On macOS and Linux it returns immediately while the packaged Launcher keeps supervising in the background. On Windows, the command remains attached until Codex Desktop exits so shells that clean up process trees of completed commands cannot discard the supervisor. Re-running \`codexhost\` attaches to the same controlled instance.

On macOS, \`remote install\` installs a current-user Aqua Harness broker so Background SSH Hosts can use native Claude Code login without reading, copying, or unlocking Keychain credentials.

If installation used \`--omit=optional\`, reinstall without that option so npm can select the native package for the current architecture.

If startup reports a platform package version mismatch, close Codex Desktop and run the exact reinstall command in the error. This installs both the CLI and its platform package at the same version, replacing stale independently installed payloads. \`codexhost --version\` reports the CLI package version; startup also validates the platform payload before launching it.
`;
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink())
      throw new Error(`npm meta package contains a symlink: ${relative}`);
    if (metadata.isDirectory()) files.push(...(await walkFiles(root, absolute)));
    else if (metadata.isFile()) files.push(relative);
    else throw new Error(`npm meta package contains a non-file: ${relative}`);
  }
  return files;
}

export async function validateNpmMetaPackage({ packageRoot }) {
  const expected = expectedNpmMetaPackagePaths().sort();
  const actual = (await walkFiles(packageRoot)).sort();
  if (expected.join("\n") !== actual.join("\n")) {
    throw new Error(
      `npm meta package files differ: expected ${expected.join(", ")}; got ${actual.join(", ")}`,
    );
  }
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== NPM_PACKAGE_NAME)
    throw new Error(`npm meta package name must be ${NPM_PACKAGE_NAME}`);
  if (manifest.bin?.codexhost !== "bin/codexhost.js") {
    throw new Error("npm meta package must expose bin/codexhost.js");
  }
  if (manifest.os !== undefined || manifest.cpu !== undefined) {
    throw new Error("npm meta package must be architecture-neutral");
  }
  return actual;
}

export async function prepareNpmMetaPackage({
  version,
  root = repositoryRoot,
  platformBaseUrl,
  platformTargets,
}) {
  const packageVersion = await resolveNpmPackageVersion(root, version);
  const outputRoot = path.join(root, "build", "npm", packageVersion, "meta");
  const packageRoot = path.join(outputRoot, "package");
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "bin", "codexhost.js"),
    createNpmBinLauncherSource({ version: packageVersion }),
    "utf8",
  );
  await chmod(path.join(packageRoot, "bin", "codexhost.js"), 0o755);
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      createNpmMetaPackageManifest({ version: packageVersion, platformBaseUrl, platformTargets }),
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(packageRoot, "README.md"),
    createNpmMetaReadme({ version: packageVersion }),
  );
  await validateNpmMetaPackage({ packageRoot });
  return { outputRoot, packageRoot, version: packageVersion };
}

export function npmMetaTarballFileName(version) {
  return `codexhost-cli-${version}.tgz`;
}

export async function packNpmMetaPackage({ outputRoot, packageRoot, version }) {
  const packedPath = await packNpmPackage({ outputRoot, packageRoot });
  const expectedPath = path.join(outputRoot, npmMetaTarballFileName(version));
  if (path.resolve(packedPath) !== path.resolve(expectedPath)) {
    await rm(expectedPath, { force: true });
    await rename(packedPath, expectedPath);
  }
  return expectedPath;
}

export async function runNpmMetaReleaseCli(arguments_) {
  let version;
  let pack = false;
  let platformBaseUrl;
  let platformTargets;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--pack") pack = true;
    else if (argument === "--version") version = arguments_[++index];
    else if (argument.startsWith("--version=")) version = argument.slice("--version=".length);
    else if (argument === "--platform-base-url") platformBaseUrl = arguments_[++index];
    else if (argument === "--platform-targets") {
      platformTargets = (arguments_[++index] ?? "").split(",").filter(Boolean);
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "usage: npm run release:npm:meta -- --version <semver> [--pack] [--platform-base-url <url> [--platform-targets macos-arm64,linux-x64]]",
      );
      return;
    } else throw new Error(`unknown npm meta release option: ${argument}`);
  }
  if (platformTargets !== undefined && platformBaseUrl === undefined) {
    throw new Error("--platform-targets requires --platform-base-url");
  }
  const prepared = await prepareNpmMetaPackage({ version, platformBaseUrl, platformTargets });
  console.log(`package=${prepared.packageRoot}`);
  console.log(`version=${prepared.version}`);
  if (pack) {
    console.log(`tarball=${await packNpmMetaPackage(prepared)}`);
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runNpmMetaReleaseCli(process.argv.slice(2)).catch((error) => {
    console.error(`codexhost npm meta release: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
