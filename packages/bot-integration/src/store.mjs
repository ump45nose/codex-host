import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Process-scoped mutation lock; crashed owners are reclaimed before a new writer enters. */
export async function locked(file, action) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      handle = await open(file, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (process.env.CODEXHOST_BOT_LOCK_HELD === "1") {
        await rm(file, { force: true });
        continue;
      }
      try {
        const owner = JSON.parse(await readFile(file, "utf8"));
        try {
          process.kill(owner.pid, 0);
        } catch (failure) {
          if (failure.code !== "ESRCH") throw failure;
          const current = await readJson(file);
          if (current?.nonce === owner.nonce) await rm(file, { force: true });
        }
      } catch (failure) {
        if (failure.code !== "ENOENT" && !(failure instanceof SyntaxError)) throw failure;
        if (failure instanceof SyntaxError && Date.now() - (await stat(file)).mtimeMs > 10_000)
          fail("LOCK_CORRUPT", "An incomplete integration lock requires recovery");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!handle) fail("BUSY", "Another integration operation is still running; retry this request");
  await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(file, { force: true });
  }
}
