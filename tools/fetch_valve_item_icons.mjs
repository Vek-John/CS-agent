#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SOURCE_BASE_URL = "https://cs2replays.com/icons";
const SOURCE_INDEX_URL = "https://cs2replays.com/js/app.js";
const SOURCE_INDEX_SHA256 = "a8a8c7386dd387fdb506d78b3891b7f4b12630c7d7e889f32dfd07503d76f648";
const SOURCE_REVISION = `cs2replays-icons@app.js-sha256-${SOURCE_INDEX_SHA256}`;
const OUTPUT_DIR = path.resolve(process.cwd(), "apps/web/public/generated-assets/items");
const FETCH_TIMEOUT_MS = 30_000;

// These hashes pin the exact public SVG bytes inspected on 2026-08-13. The
// generator refuses changed bytes instead of silently accepting a new asset.
const SOURCE_SHA256 = Object.freeze({
  ak47: "d0f98522d69a90d2dae644e29e114e9520ec7186e0cd462f1541ab0ef3289bfe",
  armor: "57e008aba6c52c6f8dc61f78599932072ec2f2101dcab754f75e7f0ac7d6d711",
  armor_helmet: "bd10d6837ee1f23ab505c68aacf93e0d6dbd4b6c6021ccbd9325ac740b4881d0",
  aug: "145aa54e61b616544e86ec895ba303c7a6480a197c6176a07265f5f234b5bc52",
  awp: "21e1c6ccbef3a93bc5e984587fa97a0de64417646a48a789864d0e5731a625d6",
  bayonet: "2dfdb1d3e1e2f9f3374d49cd7589b4fc450cfc91111e0670d5739327e82d2a86",
  bizon: "ae6259ba48323e132d37a2df13d162101898c35b3a1873e1b8913c8c193f9905",
  c4: "4ccfa5c0b98f54e3815f92779814d5ef3ddb6f01d2f3ccebd049372efb2ee310",
  cz75a: "bc0fdaf5d7806adca94a9d4224d73d4819a6966ec989570682ffa62febcff89b",
  deagle: "5ab139d7151ceaa530deb352a08146ce625ce5a9f0fcf1b8554c57c42999b950",
  decoy: "2d49015e12f7ad1217d89509fedd5801e0103c646a22d144509004147a3b67b0",
  defuser: "9810a89c92279b7eeeb1837d16a0a9a7a782114fb8e23aeb5d48872146bdf3be",
  elite: "f8e43a50d1b21bc30843c61b543bd965d108010d5f4998e6ffa44a9f96b3630f",
  famas: "ba5d5bed81d8efd6fcd049d8400c5a78a587a9f62f0585910b4cff593d8030ec",
  fiveseven: "7b9aa3b6fdb84329a43e537dff69275b224d548cbd73e7eb1272fa973322dcda",
  flashbang: "bccb65a3452c6695a342654566510e6f20352d4449740ad477c2a4eeea3d3645",
  g3sg1: "a4806843e5010f9cdf6349b58998a976703ec65d44b0862ddaf78673609d583a",
  galilar: "935b679077b5a6ea4264e66541260fb905a058f5b999e82191b79e1d94452c56",
  glock: "0ca4c81b4888d84e54e699cc4831a69992005e246dc24ffb9aa52cade6133692",
  healthshot: "340dd961ee5096e41860e1d3bc065043ccfdafb1b36c311522ce00b1823397ec",
  hegrenade: "8c33330ea8db7626d62fd6cd60139e2242be9e4b5adde54a5d43a967c462e479",
  hkp2000: "66fe96c04579615f3491d662770511785d57557c2bcc21ac81dddfc0ba65238a",
  incgrenade: "7c87dec72d1c0c622ba248fa88a6cd75f91671086a995e6a72201c9404a205d2",
  knife: "865edd79e600f5812dbaf910438af1f4ca2fb74a75fa815cc00d95802de25185",
  knife_bowie: "4045c643ee98ed91a02ec90780e35ce38045c9aacb4cfa294a6d80588cb02e5c",
  knife_butterfly: "efe285cdfd79b518544ccf6fc0203b8c25517c4ae36f27d640caff37c1db34fc",
  knife_canis: "e67136c2bf4fe95c637fa5ef897ec22852419f7326a7a4b9a77d488b1faf675a",
  knife_cord: "1ca8f25a7272c9ac68938409a23eb5e5cd6667d8c46167e1217ef7f34ff892ac",
  knife_css: "a5a8ae19f0d669524f63697b3364e3405dc0e233343b62fa3ed8eaed2a64dcd9",
  knife_falchion: "ae2f359bed8616c1d84e02c39211888a2ad2ca403e0fd6a9702a11d06e0223cc",
  knife_flip: "60d0c80a50a1c0bc868022a66b0dcf04f1581a15374f44bf7fb9e60b13a276de",
  knife_gut: "fd99f93a3f13ce2ea0707ecec0782b64df15800ddcdc48923f021450886e7b17",
  knife_gypsy_jackknife: "79fd9c5895ecd945a98f90c6da25d07bf564be0d1b0c75bbf92c8675c152161f",
  knife_karambit: "6331908a5dd5b8133619910a8435bd4f466a9332d82971eb8cacc005637d00e2",
  knife_kukri: "6da3005441cf3b8070c191cf0c65249dae59dd7b7d6ba91043f621467c889bb3",
  knife_m9_bayonet: "24f15d95965434cd9335868ede8c0dcae120e7fcea028179e5039daeaac81ac8",
  knife_outdoor: "408f30849b86d7bf5a8ac190bf3588943b660df88d9dc8c4ad8bbb57a66fe395",
  knife_push: "673892df666df0e5d1cbc470e00a19b123e9d05539ee10d063483d2c1cbe1645",
  knife_skeleton: "e9d657fa897d5976d9ceff048687e73a2097d76f96b12556c17d353703e31847",
  knife_stiletto: "10f28d76011b29fa9bae8e539df3c6c8448bf6fc8f6e2f3f820471412e2f95f5",
  knife_tactical: "2b115d5911c397c20fb3c7130c392ec27498c3b6b00fd59015bcd74ae40f6d02",
  knife_twinblade: "ac5ae164dd93119fcb8a5bfad7cea06f5c7a9d61710eefef0991af3e9d86e9c6",
  knife_ursus: "9adbc60d84e303ff08c159330db3e31ae8c350292b9c261289e34b14bec7db63",
  knife_widowmaker: "5c6d3a1a62f0cf2321cd6243ccf27e8512935d86154d91cdb6ae5e78ceb8f0c7",
  m249: "7c1b49390f87bdf8ce3f4b1fa0f54ef058b42b52ece09c6e4da92b5cd5f49787",
  m4a1: "4e80e247608b65016e4606c00f49d55492a0f1dc34e71a6b7c7ca88d27cdc650",
  m4a1_silencer: "3565857c155b80c0d2289454c1f63c231994229b3e4b347ab594e67203f65035",
  mac10: "2aafac43011b01bf92f05729bacd09dc939ed492b06e3b6f0a4c33b200d37362",
  mag7: "6c6324b36f5ba9512ea32334222f4a84e4c8f00efe3e7bd0bcd32aeacd5ea272",
  molotov: "bb4b5a04eefa1f4cbe7312969a09d2dc70dd2c2cc02b9938fa8e48c0ea4a2a4d",
  mp5sd: "293459424fa4f707e2633db6e25897f34a12795bee702fc6caaf5e83902593d2",
  mp7: "21d90992afa8a726542e861a4dfb07a154a36a06c875d3096709944a85768813",
  mp9: "6e62964b1ebe9e50c2584a771e24eaa4c6f63fc5204648c3d178fb81a938c799",
  negev: "743eccc4dace49146e82a68c1dcd333a9b5be30aa08aba3c86db7fca9a360dc0",
  nova: "9a2d5e7db9dcf0211a588d73f6dbbfbff22d79d0a858bb8cc34b6de5302c6467",
  p250: "df86b3b3a4f2168610dfcde2796577f9aaa4049ad23f9b7cca60b8d78c4ee0ea",
  p90: "13d3a3fa692b16c280f08cceba7bad8bf89225526a70e9be10a00cd0c64c4057",
  planted_c4: "fa96cc9eefa17acb6e0e8891f76b50c9b3c3964d171e4e0125bd31c9617dae31",
  revolver: "e0c5ba5ba7b0cdad3b775dd345ec7cb34243346fb84645e2e17ea8a39194a855",
  sawedoff: "45a3f55fa526d6948033d99a50cd965b7ecfa6c3eb810785f3d74ffb5556b061",
  scar20: "177b6a4490be9a2d456f9cc933ae7aa14b7ff6d7fb858473fb7cae019a790b0e",
  sg556: "6c0105235017802611d302d11bac4bdf9e83e9edeb6b5d91bbf449052128d3f3",
  smokegrenade: "fdf505befaa9d3dbf04d27204088b93e5941ba62ed8744e9675c907aa69056f9",
  ssg08: "82bbb1b093f405a26f87c2e85d07909267814f117ce7a9035ef4ee3e23fd2ced",
  taser: "a3e119853a03ebbb0267ff7721246c5ae5132dd6b325ec21d74638dc72a7b7ec",
  tec9: "dce734f0a08b42aa6ebb7946d1c3653823c4c70da99d05f2b23afa6ba80b27a6",
  ump45: "db234c16c85e5f7aa81821cdd41303857783673ca96792072c9ba51205108124",
  usp_silencer: "6f2693049050b883cbabeac89437fbcb8504520ec779156d4f7877e077ec3d7c",
  xm1014: "ec202a1ccdda27830262f764ac741eba5349211eb72776e4f8e65e78ec0ccea5"
});

function icon(canonicalItemId, sourceName, displayName, itemClass, aliases = []) {
  if (!SOURCE_SHA256[sourceName]) throw new Error(`Missing source pin for ${sourceName}.svg`);
  return { canonicalItemId, sourceName, displayName, itemClass, aliases };
}

const ICONS = Object.freeze([
  icon("weapon_ak47", "ak47", "AK-47", "RIFLE", ["ak47", "ak-47"]),
  icon("weapon_aug", "aug", "AUG", "RIFLE"),
  icon("weapon_awp", "awp", "AWP", "RIFLE"),
  icon("weapon_bizon", "bizon", "PP-Bizon", "SMG"),
  icon("weapon_c4", "c4", "C4", "OBJECTIVE", ["c4"]),
  icon("weapon_cz75a", "cz75a", "CZ75-Auto", "PISTOL", ["cz75-auto"]),
  icon("weapon_deagle", "deagle", "Desert Eagle", "PISTOL"),
  icon("weapon_decoy", "decoy", "Decoy Grenade", "GRENADE"),
  icon("weapon_elite", "elite", "Dual Berettas", "PISTOL"),
  icon("weapon_famas", "famas", "FAMAS", "RIFLE"),
  icon("weapon_fiveseven", "fiveseven", "Five-SeveN", "PISTOL", ["five-seven"]),
  icon("weapon_flashbang", "flashbang", "Flashbang", "GRENADE"),
  icon("weapon_g3sg1", "g3sg1", "G3SG1", "RIFLE"),
  icon("weapon_galilar", "galilar", "Galil AR", "RIFLE"),
  icon("weapon_glock", "glock", "Glock-18", "PISTOL"),
  icon("weapon_healthshot", "healthshot", "Medi-Shot", "EQUIPMENT"),
  icon("weapon_hegrenade", "hegrenade", "High Explosive Grenade", "GRENADE"),
  icon("weapon_hkp2000", "hkp2000", "P2000", "PISTOL", ["p2000", "weapon_p2000"]),
  icon("weapon_incgrenade", "incgrenade", "Incendiary Grenade", "GRENADE"),
  icon("weapon_m249", "m249", "M249", "HEAVY"),
  icon("weapon_m4a1", "m4a1", "M4A4", "RIFLE", ["m4a4", "weapon_m4a4"]),
  icon("weapon_m4a1_silencer", "m4a1_silencer", "M4A1-S", "RIFLE", ["m4a1-s", "weapon_m4a1_s"]),
  icon("weapon_mac10", "mac10", "MAC-10", "SMG", ["mac-10"]),
  icon("weapon_mag7", "mag7", "MAG-7", "HEAVY"),
  icon("weapon_molotov", "molotov", "Molotov", "GRENADE"),
  icon("weapon_mp5sd", "mp5sd", "MP5-SD", "SMG"),
  icon("weapon_mp7", "mp7", "MP7", "SMG"),
  icon("weapon_mp9", "mp9", "MP9", "SMG"),
  icon("weapon_negev", "negev", "Negev", "HEAVY"),
  icon("weapon_nova", "nova", "Nova", "HEAVY"),
  icon("weapon_p250", "p250", "P250", "PISTOL"),
  icon("weapon_p90", "p90", "P90", "SMG"),
  icon("weapon_revolver", "revolver", "R8 Revolver", "PISTOL", ["r8 revolver"]),
  icon("weapon_sawedoff", "sawedoff", "Sawed-Off", "HEAVY"),
  icon("weapon_scar20", "scar20", "SCAR-20", "RIFLE"),
  icon("weapon_sg556", "sg556", "SG 553", "RIFLE"),
  icon("weapon_smokegrenade", "smokegrenade", "Smoke Grenade", "GRENADE"),
  icon("weapon_ssg08", "ssg08", "SSG 08", "RIFLE", ["ssg 08"]),
  icon("weapon_taser", "taser", "Zeus x27", "EQUIPMENT"),
  icon("weapon_tec9", "tec9", "Tec-9", "PISTOL"),
  icon("weapon_ump45", "ump45", "UMP-45", "SMG"),
  icon("weapon_usp_silencer", "usp_silencer", "USP-S", "PISTOL", ["usp-s", "weapon_usp_s"]),
  icon("weapon_xm1014", "xm1014", "XM1014", "HEAVY"),
  icon("weapon_bayonet", "bayonet", "Bayonet", "MELEE"),
  icon("weapon_knife", "knife", "Knife", "MELEE", ["knife"]),
  icon("weapon_knife_t", "knife", "T Knife", "MELEE", ["knife_t"]),
  icon("weapon_knife_butterfly", "knife_butterfly", "Butterfly Knife", "MELEE"),
  icon("weapon_knife_canis", "knife_canis", "Nomad Knife", "MELEE"),
  icon("weapon_knife_cord", "knife_cord", "Paracord Knife", "MELEE"),
  icon("weapon_knife_css", "knife_css", "Classic Knife", "MELEE"),
  icon("weapon_knife_falchion", "knife_falchion", "Falchion Knife", "MELEE"),
  icon("weapon_knife_flip", "knife_flip", "Flip Knife", "MELEE"),
  icon("weapon_knife_gut", "knife_gut", "Gut Knife", "MELEE"),
  icon("weapon_knife_gypsy_jackknife", "knife_gypsy_jackknife", "Navaja Knife", "MELEE", ["weapon_knife_navaja"]),
  icon("weapon_knife_karambit", "knife_karambit", "Karambit", "MELEE"),
  icon("weapon_knife_kukri", "knife_kukri", "Kukri Knife", "MELEE"),
  icon("weapon_knife_m9_bayonet", "knife_m9_bayonet", "M9 Bayonet", "MELEE"),
  icon("weapon_knife_outdoor", "knife_outdoor", "Survival Knife", "MELEE"),
  icon("weapon_knife_push", "knife_push", "Shadow Daggers", "MELEE"),
  icon("weapon_knife_skeleton", "knife_skeleton", "Skeleton Knife", "MELEE"),
  icon("weapon_knife_stiletto", "knife_stiletto", "Stiletto Knife", "MELEE"),
  icon("weapon_knife_survival_bowie", "knife_bowie", "Bowie Knife", "MELEE", ["weapon_knife_bowie", "bowie knife"]),
  icon("weapon_knife_tactical", "knife_tactical", "Huntsman Knife", "MELEE", ["weapon_huntsman_knife", "huntsman knife"]),
  icon("weapon_knife_twinblade", "knife_twinblade", "Twin Blade", "MELEE"),
  icon("weapon_knife_ursus", "knife_ursus", "Ursus Knife", "MELEE"),
  icon("weapon_knife_widowmaker", "knife_widowmaker", "Talon Knife", "MELEE"),
  icon("armor", "armor", "Kevlar Vest", "EQUIPMENT", ["kevlar", "vest"]),
  icon("armor_helmet", "armor_helmet", "Kevlar + Helmet", "EQUIPMENT", ["helmet", "vesthelm", "assaultsuit"]),
  icon("defuse_kit", "defuser", "Defuse Kit", "EQUIPMENT", ["defuser", "weapon_defuser"]),
  icon("planted_c4", "planted_c4", "Planted C4", "OBJECTIVE")
]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseDimension(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.ceil(number)) : undefined;
}

export function svgDimensions(source) {
  const viewBox = source.match(/\bviewBox\s*=\s*["']\s*[-+\d.e]+[ ,]+[-+\d.e]+[ ,]+([-+\d.e]+)[ ,]+([-+\d.e]+)\s*["']/i);
  if (viewBox) {
    const width = parseDimension(viewBox[1]);
    const height = parseDimension(viewBox[2]);
    if (width && height) return { width, height };
  }
  const root = source.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const width = parseDimension(root.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1] ?? "");
  const height = parseDimension(root.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1] ?? "");
  if (!width || !height) throw new Error("SVG has no usable viewBox or dimensions.");
  return { width, height };
}

function replacePaintAttribute(_match, attribute, quote, value) {
  const normalized = value.trim().toLowerCase();
  return normalized === "none"
    ? `${attribute}=${quote}none${quote}`
    : `${attribute}=${quote}currentColor${quote}`;
}

function rootAttribute(root, name) {
  return root.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([^"']*)\\1`, "i"))?.[2];
}

function escapeXmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizedRoot(root, dimensions) {
  const width = rootAttribute(root, "width") ?? String(dimensions.width);
  const height = rootAttribute(root, "height") ?? String(dimensions.height);
  const viewBox = rootAttribute(root, "viewBox") ?? `0 0 ${dimensions.width} ${dimensions.height}`;
  const attributes = [
    ["xmlns", rootAttribute(root, "xmlns") ?? "http://www.w3.org/2000/svg"],
    ["width", width],
    ["height", height],
    ["viewBox", viewBox]
  ].map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`);
  return `<svg ${attributes.join(" ")} color="#FFFFFF" fill="currentColor" data-render-mode="monochrome">`;
}

/** Normalize trusted, pinned game-depot silhouettes into a tint-ready SVG. */
export function normalizeMonochromeSvg(buffer) {
  const source = buffer.toString("utf8");
  if (!/<svg\b/i.test(source) || /<\s*(?:script|foreignObject|image)\b/i.test(source)) {
    throw new Error("Icon source is not a supported standalone SVG.");
  }
  if (/\son[a-z]+\s*=|\b(?:href|xlink:href)\s*=/i.test(source)) {
    throw new Error("Icon source contains an active or external SVG reference.");
  }
  const dimensions = svgDimensions(source);
  const sourceRoot = source.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  let svg = source
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  svg = svg
    .replace(/\b(fill|stroke)\s*=\s*(["'])([^"']+)\2/gi, replacePaintAttribute)
    .replace(/(\b(?:fill|stroke)\s*:\s*)(?!none\b|currentColor\b)[^;"'}]+/gi, "$1currentColor");
  svg = svg.replace(/<svg\b[^>]*>/i, normalizedRoot(sourceRoot, dimensions));
  if (!/currentColor/.test(svg)) throw new Error("SVG normalization did not produce currentColor paint.");
  return { buffer: Buffer.from(`${svg}\n`, "utf8"), ...dimensions };
}

async function fetchBuffer(url) {
  let failure;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn("curl", [
          "-fsSL", "--compressed", "--retry", "3", "--retry-all-errors", "--connect-timeout", "10",
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

function aliasesFor(item) {
  return [...new Set([
    item.canonicalItemId,
    item.canonicalItemId.replace(/^weapon_/, ""),
    ...item.aliases
  ])];
}

async function removePriorGeneratedImages() {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.flatMap((entry) => {
    if (!entry.isFile() || !/\.(?:png|svg)$/i.test(entry.name)) return [];
    return [unlink(path.join(OUTPUT_DIR, entry.name))];
  }));
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const prepared = [];
  for (const item of ICONS) {
    const sourceUri = `${SOURCE_BASE_URL}/${item.sourceName}.svg`;
    const sourceBuffer = await fetchBuffer(sourceUri);
    const sourceContentSha256 = sha256(sourceBuffer);
    if (sourceContentSha256 !== SOURCE_SHA256[item.sourceName]) {
      throw new Error(
        `Source drift for ${sourceUri}: expected ${SOURCE_SHA256[item.sourceName]}, received ${sourceContentSha256}.`
      );
    }
    const normalized = normalizeMonochromeSvg(sourceBuffer);
    prepared.push({ item, sourceUri, sourceContentSha256, ...normalized });
  }

  // The directory is a generated localhost cache. Only replace its generated
  // image formats after every remote asset has passed its pin and SVG checks.
  await removePriorGeneratedImages();
  const icons = [];
  for (const preparedIcon of prepared) {
    const { item, sourceUri, sourceContentSha256, buffer, width, height } = preparedIcon;
    const fileName = `${item.canonicalItemId}.svg`;
    await writeFile(path.join(OUTPUT_DIR, fileName), buffer);
    icons.push({
      canonical_item_id: item.canonicalItemId,
      item_class: item.itemClass,
      display_name: item.displayName,
      aliases: aliasesFor(item),
      raster_ref: `/generated-assets/items/${fileName}`,
      width,
      height,
      content_sha256: sha256(buffer),
      source_uri: sourceUri,
      source_content_sha256: sourceContentSha256,
      media_type: "image/svg+xml",
      render_mode: "MONOCHROME_CURRENT_COLOR",
      rights_status: "LOCALHOST_ONLY"
    });
  }
  const catalog = {
    game_build_id: "steam-app-730",
    asset_version: "valve-hud-items/2.0.0-localhost",
    maps: [],
    item_icons: icons,
    generated_at: new Date().toISOString(),
    generation_manifest: {
      generator: "tools/fetch_valve_item_icons.mjs",
      generator_version: "2.0.0",
      source_revision: SOURCE_REVISION,
      source_index_uri: SOURCE_INDEX_URL,
      source_index_sha256: SOURCE_INDEX_SHA256,
      redistribution_policy: "LOCALHOST_ONLY",
      rights_note: "User-authorized Valve game HUD asset cache; upstream page provides no standalone icon-license grant. Public redistribution requires review.",
      normalization: "Standalone SVG sanitized; non-none fill/stroke normalized to currentColor; root defaults to white."
    }
  };
  await writeFile(path.join(OUTPUT_DIR, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output_dir: OUTPUT_DIR,
    icon_count: icons.length,
    source_revision: SOURCE_REVISION,
    asset_version: catalog.asset_version
  })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
