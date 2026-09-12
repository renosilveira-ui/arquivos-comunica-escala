#!/usr/bin/env node
/**
 * Gera os PNG das cenas de clima da saudação a partir de
 * assets/weather/source/scenes.mjs — arte aprovada pelo PO em 12/09/2026.
 *
 * Saídas (assets/weather/), três densidades por cena:
 *     <cena>.png     64²    1×
 *     <cena>@2x.png  128²   2×
 *     <cena>@3x.png  192²   3×
 *
 * Uso:  node scripts/weather/generate-scenes.mjs
 *       node scripts/weather/generate-scenes.mjs --only n-frio,n-neblina
 *
 * ## Por que Chrome e não resvg/sharp
 *
 * O realismo depende de `feTurbulence` + `feDisplacementMap`. Os
 * renderizadores baseados em librsvg/resvg não implementam esses filtros e
 * exportariam nuvens de círculo somado — exatamente o que a arte evita. Só um
 * motor de browser rende fiel, e por isso este script usa o Chrome já
 * instalado na máquina em vez de acrescentar dependência ao projeto.
 *
 * ## SHIPPED
 *
 * Nem toda cena de `scenes.mjs` é exportada. `parcial`, `calor` e `vento` não
 * têm origem em `WEATHER_CONDITIONS` — o provedor não distingue parcialmente
 * nublado, não expõe índice de calor e não reporta vento. Exportá-las criaria
 * asset morto no bundle. A arte fica guardada na fonte para o dia em que o
 * provedor crescer.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENES, sceneSvg } from "../../assets/weather/source/scenes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const OUT = join(REPO, "assets/weather");

/** Cenas alcançáveis a partir de WEATHER_CONDITIONS × hora. Ver lib/weather-scene.ts. */
const SHIPPED = new Set([
  "limpo", "amanhecer", "entardecer", "nublado", "chuva", "tempestade",
  "neblina", "frio",
  "n-limpo", "n-nublado", "n-chuva", "n-tempestade", "n-neblina", "n-frio",
]);

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      statSync(p);
      return p;
    } catch {
      /* tenta o próximo */
    }
  }
  throw new Error(
    "Chrome não encontrado. Instale o Google Chrome ou edite CHROME_CANDIDATES.",
  );
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = Number(arg("base", 64));
const onlyArg = arg("only", "");
const only = onlyArg ? new Set(onlyArg.split(",")) : null;
const DENSITIES = [
  { suffix: "", scale: 1 },
  { suffix: "@2x", scale: 2 },
  { suffix: "@3x", scale: 3 },
];

const chrome = findChrome();
mkdirSync(OUT, { recursive: true });
const tmp = join(OUT, ".tmp");
mkdirSync(tmp, { recursive: true });

let files = 0;
let bytes = 0;
const skipped = [];

for (const scene of SCENES) {
  if (!SHIPPED.has(scene.id)) {
    skipped.push(scene.id);
    continue;
  }
  if (only && !only.has(scene.id)) continue;
  for (const { suffix, scale } of DENSITIES) {
    const px = BASE * scale;
    const svg = sceneSvg(scene, `x${scale}`).replace(
      "<svg ",
      `<svg width="${px}" height="${px}" `,
    );
    const page = join(tmp, `${scene.id}${suffix}.html`);
    writeFileSync(page, `<body style="margin:0;background:transparent">${svg}</body>`);
    const png = join(OUT, `${scene.id}${suffix}.png`);
    execFileSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--default-background-color=00000000",
        `--window-size=${px},${px}`,
        `--screenshot=${png}`,
        `file://${page}`,
      ],
      { stdio: "pipe" },
    );
    files += 1;
    bytes += statSync(png).size;
  }
}

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${files} arquivos em assets/weather/`);
console.log(`peso total: ${(bytes / 1024).toFixed(1)} kB`);
if (skipped.length) {
  console.log(`\nfora do bundle (sem origem em WEATHER_CONDITIONS): ${skipped.join(", ")}`);
}
