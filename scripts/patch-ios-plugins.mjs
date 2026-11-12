#!/usr/bin/env node
/**
 * Post-sync patch for the iOS native project.
 *
 * `npx cap sync ios` generates ios/App/App/capacitor.config.json and fills
 * `packageClassList` with the Swift classes of every Capacitor plugin found in
 * node_modules. Plugins written directly inside this repository (currently
 * ios/App/App/Plugins/WebRenderer.swift) are NOT in node_modules, so Capacitor
 * never discovers them and `Capacitor.Plugins.WebRenderer` stays undefined at
 * runtime (src/services/render.ts then throws "nativní modul není k dispozici").
 *
 * This script appends the local plugin classes to packageClassList so that
 * Capacitor's auto-registration (NSClassFromString) finds them.
 *
 * Run automatically by `npm run ios:sync` and by the Codemagic workflow.
 */
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "ios", "App", "App", "capacitor.config.json");
const PLUGINS_DIR = path.join(ROOT, "ios", "App", "App", "Plugins");

/**
 * Maps the @objc(...) class name declared in each local Swift file.
 * Add a line here when you add another in-repo plugin.
 */
const LOCAL_PLUGINS = [{ file: "WebRenderer.swift", className: "WebRenderer" }];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(CONFIG_PATH))) {
    console.error(`[patch-ios-plugins] Missing ${CONFIG_PATH}. Run "npx cap sync ios" first.`);
    process.exit(1);
  }

  const raw = await readFile(CONFIG_PATH, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    console.error(`[patch-ios-plugins] ${CONFIG_PATH} is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const classList = Array.isArray(config.packageClassList) ? config.packageClassList : [];
  const added = [];

  for (const plugin of LOCAL_PLUGINS) {
    const sourcePath = path.join(PLUGINS_DIR, plugin.file);
    if (!(await exists(sourcePath))) {
      console.warn(`[patch-ios-plugins] Skipping ${plugin.className}: ${sourcePath} not found.`);
      continue;
    }
    if (!classList.includes(plugin.className)) {
      classList.push(plugin.className);
      added.push(plugin.className);
    }
  }

  config.packageClassList = classList;
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, "\t")}\n`, "utf8");

  if (added.length) {
    console.log(`[patch-ios-plugins] Registered local iOS plugins: ${added.join(", ")}`);
  } else {
    console.log("[patch-ios-plugins] Local iOS plugins already registered.");
  }
  console.log(`[patch-ios-plugins] packageClassList = ${classList.join(", ")}`);
}

main().catch((err) => {
  console.error("[patch-ios-plugins] Failed:", err);
  process.exit(1);
});
