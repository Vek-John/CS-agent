#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DATA_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/053019c356445a1b279ceae872b936620b289c7f/public/api/en/base_weapons.json";
const SOURCE_REVISION = "CSGO-API@053019c356445a1b279ceae872b936620b289c7f";
const OUTPUT_DIR = path.resolve(process.cwd(), "apps/web/public/generated-assets/items");
const FETCH_TIMEOUT_MS = 20_000;

const ALIASES = {
  weapon_ak47: ["weapon_ak_47", "ak47", "ak-47"],
  weapon_m4a1: ["weapon_m4a4", "m4a4"],
  weapon_m4a1_silencer: ["weapon_m4a1_s", "m4a1-s"],
  weapon_hkp2000: ["weapon_p2000", "p2000"],
  weapon_cz75a: ["weapon_cz75_auto", "cz75-auto"],
  weapon_revolver: ["weapon_r8_revolver", "r8 revolver"],
  weapon_ssg08: ["weapon_ssg_08", "ssg 08"],
  weapon_mac10: ["weapon_mac_10", "mac-10"],
  weapon_knife_survival_bowie: ["weapon_bowie_knife", "bowie knife"],
  weapon_knife_tactical: ["weapon_huntsman_knife", "huntsman knife"],
  weapon_knife_m9_bayonet: ["weapon_m9_bayonet", "m9 bayonet"]
};

const EXTRA_ICON_ALIASES = {
  weapon_c4: ["c4"],
  weapon_knife: ["knife"],
  weapon_knife_t: ["knife_t"],
  weapon_flashbang: ["flashbang"],
  weapon_hegrenade: ["hegrenade"],
  weapon_smokegrenade: ["smokegrenade"],
  weapon_molotov: ["molotov"],
  weapon_incgrenade: ["incgrenade"]
};

function itemClass(categoryId) {
  if (categoryId.includes("pistols")) return "PISTOL";
  if (categoryId.includes("rifles")) return "RIFLE";
  if (categoryId.includes("smgs")) return "SMG";
  if (categoryId.includes("heavy")) return "HEAVY";
  if (categoryId.includes("grenade")) return "GRENADE";
  if (categoryId.includes("melee")) return "MELEE";
  if (categoryId.includes("c4")) return "OBJECTIVE";
  return "EQUIPMENT";
}

function dimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Valve catalog image was not a PNG.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function fetchBuffer(url) {
  let failure;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn("curl", [
          "-fsSL", "--retry", "3", "--retry-all-errors", "--connect-timeout", "10",
          "--max-time", String(FETCH_TIMEOUT_MS / 1000), url
        ], { stdio: ["ignore", "pipe", "pipe"] });
        const chunks = [];
        let stderr = "";
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolve(Buffer.concat(chunks));
          else reject(new Error(stderr.trim() || `curl exited ${code}`));
        });
      });
    } catch (error) {
      failure = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw failure;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const sourceItems = JSON.parse((await fetchBuffer(DATA_URL)).toString("utf8"));
  const icons = [];
  for (const source of sourceItems) {
    const canonicalId = source.id.replace(/^base_weapon-/, "");
    const buffer = await fetchBuffer(source.image);
    const { width, height } = dimensions(buffer);
    const fileName = `${canonicalId}.png`;
    await writeFile(path.join(OUTPUT_DIR, fileName), buffer);
    icons.push({
      canonical_item_id: canonicalId,
      item_class: itemClass(source.category.id),
      display_name: source.name,
      aliases: [...new Set([
        canonicalId,
        canonicalId.replace(/^weapon_/, ""),
        ...(ALIASES[canonicalId] ?? []),
        ...(EXTRA_ICON_ALIASES[canonicalId] ?? [])
      ])],
      raster_ref: `/generated-assets/items/${fileName}`,
      width,
      height,
      content_sha256: createHash("sha256").update(buffer).digest("hex"),
      source_uri: source.image,
      rights_status: "LOCALHOST_ONLY"
    });
  }
  const catalog = {
    game_build_id: "steam-app-730",
    asset_version: "valve-items/1.0.0-localhost",
    maps: [],
    item_icons: icons,
    generated_at: new Date().toISOString(),
    generation_manifest: {
      generator: "tools/fetch_valve_item_icons.mjs",
      generator_version: "1.0.0",
      source_revision: SOURCE_REVISION
    }
  };
  await writeFile(path.join(OUTPUT_DIR, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output_dir: OUTPUT_DIR, icon_count: icons.length, source_revision: SOURCE_REVISION })}\n`);
}

await main();
