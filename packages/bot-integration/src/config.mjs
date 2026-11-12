import path from "node:path";
import { readJson, fail } from "./store.mjs";

function absolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0]/u.test(value))
    fail("CONFIG_INVALID", `${name} must be an absolute path`);
  return value;
}

export async function loadConfig(environment = process.env) {
  const file = environment.CODEXHOST_BOT_CONFIG;
  if (!file)
    fail("CONFIG_REQUIRED", "Set CODEXHOST_BOT_CONFIG to the installed private configuration");
  const config = await readJson(absolute(file, "CODEXHOST_BOT_CONFIG"));
  if (config?.version !== 1 || !Array.isArray(config.devices) || !config.devices.length)
    fail("CONFIG_INVALID", "Expected integration configuration version 1 with devices");
  for (const field of ["privateDir", "exportDir", "commandPath"]) absolute(config[field], field);
  const ids = new Set();
  for (const device of config.devices) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/u.test(device.id) || ids.has(device.id))
      fail("CONFIG_INVALID", "Device IDs must be unique lowercase names");
    ids.add(device.id);
    for (const field of ["cli", "node", "dataDir", "privateDir"])
      absolute(device[field], `${device.id}.${field}`);
    if (device.transport !== "local" && device.transport !== "ssh")
      fail("CONFIG_INVALID", "Device transport must be local or ssh");
    if (device.transport === "ssh") {
      if (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/u.test(device.ssh?.destination ?? ""))
        fail("CONFIG_INVALID", "SSH destination must be user@host");
      absolute(device.ssh.identityFile, "SSH identityFile");
    }
  }
  const grok = config.grok;
  if (!grok || grok.version !== "0.79.4")
    fail("VERSION_UNSUPPORTED", "Only verified Grok Bot 0.79.4 is supported");
  for (const field of ["controller", "credentials", "machine", "packageJson"])
    absolute(grok[field], `grok.${field}`);
  if ((await readJson(grok.packageJson))?.version !== grok.version)
    fail("VERSION_UNSUPPORTED", "Installed Grok Bot version differs from the verified adapter");
  return config;
}

export function getDevice(config, id) {
  const device = config.devices.find((entry) => entry.id === id);
  if (!device) fail("DEVICE_UNKNOWN", "Requested execution device is not configured");
  return device;
}
