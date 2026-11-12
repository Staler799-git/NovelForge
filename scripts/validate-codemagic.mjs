#!/usr/bin/env node
/**
 * Validuje codemagic.yaml proti oficiálnímu Codemagic JSON schématu.
 *
 * Proč: Codemagic odmítne build, pokud yaml neodpovídá schématu, a chyba se
 * objeví až v UI ("Configuration file error ... extra fields not permitted").
 * Tento skript to odhalí lokálně i v CI ještě před během.
 *
 * Schéma je commitnuté v schema/codemagic-schema.json, takže validace
 * nevyžaduje síť. Aktualizace: npm run validate:codemagic -- --update-schema
 *
 * Použití:
 *   node scripts/validate-codemagic.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const YAML = require("yaml");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ROOT = process.cwd();
const YAML_PATH = path.join(ROOT, "codemagic.yaml");
const SCHEMA_PATH = path.join(ROOT, "schema", "codemagic-schema.json");
const SCHEMA_URL =
  "https://raw.githubusercontent.com/codemagic-ci-cd/codemagic-init/main/src/codemagic_init/data/codemagic-schema.json";

const updating = process.argv.includes("--update-schema");

async function loadSchema() {
  if (updating) {
    console.log(`[validate-codemagic] Stahuji schéma z ${SCHEMA_URL}`);
    const res = await fetch(SCHEMA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} při stahování schématu`);
    await writeFile(SCHEMA_PATH, await res.text(), "utf8");
    console.log("[validate-codemagic] Schéma aktualizováno.");
  }
  return JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
}

async function main() {
  const schema = await loadSchema();
  const source = await readFile(YAML_PATH, "utf8");

  // Parse with merge-key support so `<<` anchors (if ever used) resolve.
  const doc = YAML.parse(source, { merge: true });

  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (!validate(doc)) {
    console.error("\x1b[1;31m✖ codemagic.yaml NEPROŠEL validací proti schématu\x1b[0m\n");
    for (const err of validate.errors) {
      console.error(`  • ${err.instancePath || "(root)"} → ${err.message}`);
      if (err.params && err.params.additionalProperty) {
        console.error(`    nepovolený klíč: "${err.params.additionalProperty}"`);
      }
    }
    console.error("\nDokumentace: https://docs.codemagic.io/yaml-basic-configuration/yaml-getting-started/");
    process.exit(1);
  }

  console.log("\x1b[1;32m✔ codemagic.yaml je validní proti oficiálnímu Codemagic schématu\x1b[0m");
  for (const [id, wf] of Object.entries(doc.workflows)) {
    const scripts = Array.isArray(wf.scripts) ? wf.scripts.length : 0;
    const artifacts = Array.isArray(wf.artifacts) ? wf.artifacts.length : 0;
    console.log(`  • ${id} — "${wf.name ?? "(bez názvu)"}" | ${scripts} skriptů, ${artifacts} artefaktů`);
  }
}

main().catch((err) => {
  console.error("[validate-codemagic] Chyba:", err.message);
  process.exit(1);
});
