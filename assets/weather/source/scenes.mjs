/**
 * Fonte das cenas de clima da saudação — aprovadas pelo PO em 12/09/2026.
 *
 * Cada cena é um disco de atmosfera: céu com três paradas, nuvem com topo
 * iluminado e base na sombra, borda deslocada por ruído de Perlin. Não há
 * contorno em lugar nenhum; o volume vem da luz.
 *
 * ## Por que isto vira PNG e não componente SVG
 *
 * O realismo depende de `feTurbulence` e `feDisplacementMap`, e o
 * `react-native-svg` não implementa nenhum dos dois. Renderizado no app, o
 * mesmo código produziria nuvens de círculo somado — exatamente o que a arte
 * evita. Por isso o desenho mora aqui e o app consome PNG exportado por
 * `scripts/weather/generate-scenes.mjs`.
 *
 * ## Cenas sem origem de dado
 *
 * `parcial`, `calor` e `vento` ficam aqui mas NÃO são exportadas: o provedor
 * de clima (`WEATHER_CONDITIONS`) não distingue parcialmente nublado, não
 * expõe índice de calor e não reporta vento. Exportá-las criaria asset morto.
 * Se o provedor crescer, a arte já existe — é só entrar em SHIPPED.
 */

const F = (n) => Math.round(n * 100) / 100;

// Céus com três paradas: zênite, meio, horizonte. Duas paradas achatam a cena.
const SKY = {
  sunny: ["#1668BE", "#6BB4ED", "#CDE9FB"],
  partly: ["#2278C6", "#7ABCEF", "#D6EAF9"],
  cloudy: ["#71879F", "#A2B3C6", "#CCD7E3"],
  rain: ["#41536A", "#647890", "#95A7B9"],
  storm: ["#1D2435", "#333D52", "#525E76"],
  heat: ["#D4551A", "#F59240", "#FFD89C"],
  dawn: ["#2E3F6E", "#E4663F", "#FFCB8B"],
  dusk: ["#23265A", "#CF4527", "#FFA257"],
  wind: ["#2483CE", "#70B9EB", "#C9E5F8"],
  fog: ["#5E6E7E", "#93A2B0", "#C9D3DA"],
  cold: ["#3E6E9E", "#79A9D4", "#C6E0F2"],
  night: ["#04091A", "#0C1C3B", "#1C3357"],
  nightCloud: ["#060D1E", "#12223C", "#233856"],
  nightRain: ["#040916", "#0F1B2F", "#1C2B44"],
  nightStorm: ["#02050D", "#0A111F", "#151F2E"],
  nightFog: ["#0C141E", "#22303E", "#3E4E5C"],
  nightCold: ["#061226", "#132A4A", "#254670"],
};

const CLOUD = {
  white: ["#FFFFFF", "#EDF3FA", "#BFCDDE"],
  grey: ["#DCE3EB", "#B3BECD", "#8A97A9"],
  storm: ["#7B8799", "#4C5768", "#2B3344"],
  night: ["#4A5C77", "#2C3B52", "#182232"],
  dawn: ["#FFE0BC", "#F4AC7E", "#C0765F"],
  dusk: ["#FFC08A", "#E07B4C", "#8E4433"],
};

function lg(id, stops, x1, y1, x2, y2) {
  const s = stops
    .map((c, i) => `<stop offset="${F(i / (stops.length - 1))}" stop-color="${c}"/>`)
    .join("");
  return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${s}</linearGradient>`;
}

function turb(id, freq, scale, seed) {
  return (
    `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="4" seed="${seed}" result="n"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="n" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>` +
    `</filter>`
  );
}

function blur(id, sd) {
  return (
    `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feGaussianBlur stdDeviation="${sd}"/></filter>`
  );
}

/** Nuvem: corpo de círculos + base, gradiente de volume, borda por ruído. */
function cloud(id, cx, cy, w, pal, op, seed) {
  const h = w * 0.4;
  const gid = `cg-${id}`;
  const fid = `cf-${id}`;
  const body =
    `<rect x="${F(cx - w / 2)}" y="${F(cy - h * 0.3)}" width="${F(w)}" height="${F(h)}" rx="${F(h / 2)}"/>` +
    `<circle cx="${F(cx - w * 0.25)}" cy="${F(cy - h * 0.34)}" r="${F(w * 0.215)}"/>` +
    `<circle cx="${F(cx + w * 0.02)}" cy="${F(cy - h * 0.74)}" r="${F(w * 0.285)}"/>` +
    `<circle cx="${F(cx + w * 0.3)}" cy="${F(cy - h * 0.3)}" r="${F(w * 0.2)}"/>`;
  return {
    defs: lg(gid, pal, 0, 0, 0, 1) + turb(fid, 0.035, F(w * 0.09), seed),
    body: `<g filter="url(#${fid})" fill="url(#${gid})" opacity="${op === undefined ? 1 : op}">${body}</g>`,
  };
}

function sun(id, cx, cy, r, core, halo) {
  const g1 = `sg-${id}`;
  const g2 = `sh-${id}`;
  return {
    defs:
      `<radialGradient id="${g1}"><stop offset="0" stop-color="#FFFDF2"/>` +
      `<stop offset=".55" stop-color="${core}"/><stop offset="1" stop-color="${core}" stop-opacity=".9"/></radialGradient>` +
      `<radialGradient id="${g2}"><stop offset="0" stop-color="${halo}" stop-opacity=".85"/>` +
      `<stop offset=".45" stop-color="${halo}" stop-opacity=".30"/>` +
      `<stop offset="1" stop-color="${halo}" stop-opacity="0"/></radialGradient>`,
    body:
      `<circle cx="${cx}" cy="${cy}" r="${F(r * 3.6)}" fill="url(#${g2})"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${F(r * 1.5)}" fill="url(#${g2})"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${g1})"/>`,
  };
}

function moon(id, cx, cy, r) {
  const g = `mg-${id}`;
  const h = `mh-${id}`;
  return {
    defs:
      `<radialGradient id="${g}" cx=".38" cy=".32" r=".85">` +
      `<stop offset="0" stop-color="#FFFDF0"/><stop offset=".6" stop-color="#F2E9C8"/>` +
      `<stop offset="1" stop-color="#C9BE95"/></radialGradient>` +
      `<radialGradient id="${h}"><stop offset="0" stop-color="#DCE8FF" stop-opacity=".55"/>` +
      `<stop offset=".5" stop-color="#BBD2FF" stop-opacity=".16"/>` +
      `<stop offset="1" stop-color="#BBD2FF" stop-opacity="0"/></radialGradient>`,
    body:
      `<circle cx="${cx}" cy="${cy}" r="${F(r * 3.2)}" fill="url(#${h})"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${g})"/>` +
      `<g fill="#C3B891" opacity=".40">` +
      `<circle cx="${F(cx - r * 0.3)}" cy="${F(cy + r * 0.22)}" r="${F(r * 0.26)}"/>` +
      `<circle cx="${F(cx + r * 0.3)}" cy="${F(cy - r * 0.3)}" r="${F(r * 0.17)}"/>` +
      `<circle cx="${F(cx + r * 0.14)}" cy="${F(cy + r * 0.44)}" r="${F(r * 0.12)}"/></g>`,
  };
}

/** Brilho difuso da lua atrás da névoa: luz sem contorno, que é o que a névoa faz. */
function moonGlow(id, cx, cy, r) {
  const g = `mgl-${id}`;
  return {
    defs:
      `<radialGradient id="${g}"><stop offset="0" stop-color="#F4F7FF" stop-opacity=".72"/>` +
      `<stop offset=".35" stop-color="#D9E4F5" stop-opacity=".30"/>` +
      `<stop offset="1" stop-color="#C9D6EA" stop-opacity="0"/></radialGradient>`,
    body: `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${g})"/>`,
  };
}

function rain(list, color, wdt) {
  return list
    .map(
      (p) =>
        `<line x1="${p[0]}" y1="${p[1]}" x2="${F(p[0] - p[2] * 0.34)}" y2="${F(p[1] + p[2])}" ` +
        `stroke="${color}" stroke-width="${wdt || 1.25}" stroke-linecap="round" opacity="${p[3]}"/>`,
    )
    .join("");
}

function bolt(id, x, y, s, tint) {
  const p = [
    [0.52, 0], [0.06, 0.55], [0.4, 0.55], [0.27, 1], [0.96, 0.4], [0.57, 0.4],
  ];
  const d = "M " + p.map((q) => `${F(x + q[0] * s)} ${F(y + q[1] * s)}`).join(" L ") + " Z";
  return {
    defs: blur(`bb-${id}`, F(s * 0.1)),
    body:
      `<path d="${d}" fill="${tint}" filter="url(#bb-${id})" opacity=".95"/>` +
      `<path d="${d}" fill="#FFFDF0"/>`,
  };
}

function stars(list) {
  return list
    .map((s) => `<circle cx="${s[0]}" cy="${s[1]}" r="${s[2]}" fill="#FFFFFF" opacity="${s[3]}"/>`)
    .join("");
}

function fog(id, tint) {
  const g = `fg-${id}`;
  const c = tint || "#FFFFFF";
  const band = (y, h, o) =>
    `<rect x="-10" y="${y}" width="120" height="${h}" fill="url(#${g})" opacity="${o}"/>`;
  return {
    defs:
      `<linearGradient id="${g}" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0" stop-color="${c}" stop-opacity="0"/>` +
      `<stop offset=".5" stop-color="${c}" stop-opacity=".92"/>` +
      `<stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient>` +
      blur(`fb-${id}`, 2.4),
    body:
      `<g filter="url(#fb-${id})">${band(34, 9, 0.62)}${band(50, 12, 0.82)}` +
      `${band(68, 11, 0.72)}${band(84, 9, 0.55)}</g>`,
  };
}

function wind(id) {
  // O gancho no fim do traço é o que lê como RAJADA. Sem ele, três curvas
  // paralelas dizem "névoa" — e a cena virava irmã da neblina.
  const g1 = "M 2 36 C 26 25, 50 42, 70 33 c 11 -5, 13 -17, 2 -19 c -8 -1, -10 7, -3 10";
  const g2 = "M 8 58 C 32 48, 56 62, 76 54 c 10 -4, 11 -14, 1 -16 c -7 -1, -9 6, -2 9";
  const g3 = "M 18 76 C 38 69, 56 78, 72 72";
  return {
    defs: blur(`wb-${id}`, 2.6),
    body:
      `<g filter="url(#wb-${id})" fill="none" stroke="#FFFFFF" stroke-linecap="round" opacity=".38">` +
      `<path d="${g1}" stroke-width="6"/><path d="${g2}" stroke-width="5"/>` +
      `<path d="${g3}" stroke-width="4"/></g>` +
      `<g fill="none" stroke="#FFFFFF" stroke-linecap="round">` +
      `<path d="${g1}" stroke-width="3.4" opacity=".95"/>` +
      `<path d="${g2}" stroke-width="2.8" opacity=".78"/>` +
      `<path d="${g3}" stroke-width="2.2" opacity=".55"/></g>`,
  };
}

function snow(list) {
  return (
    "<g fill=\"#FFFFFF\">" +
    list.map((s) => `<circle cx="${s[0]}" cy="${s[1]}" r="${s[2]}" opacity="${s[3]}"/>`).join("") +
    "</g>"
  );
}

export const SCENES = [
  { id: "limpo", nm: "Ensolarado", sky: SKY.sunny,
    build: (u) => { const s = sun(u, 66, 32, 14, "#FFC42E", "#FFD86A");
      return { defs: s.defs, back: s.body }; } },

  { id: "parcial", nm: "Sol entre nuvens", sky: SKY.partly,
    build: (u) => { const s = sun(u, 70, 24, 9.5, "#FFC42E", "#FFD86A");
      const c1 = cloud(`${u}a`, 38, 52, 54, CLOUD.white, 1, 3);
      const c2 = cloud(`${u}b`, 76, 64, 34, CLOUD.white, 0.9, 7);
      return { defs: s.defs + c1.defs + c2.defs, back: s.body + c2.body + c1.body }; } },

  { id: "nublado", nm: "Nublado", sky: SKY.cloudy,
    build: (u) => { const c1 = cloud(`${u}a`, 34, 44, 52, CLOUD.grey, 1, 11);
      const c2 = cloud(`${u}b`, 70, 62, 46, CLOUD.white, 0.95, 5);
      return { defs: c1.defs + c2.defs, back: c1.body + c2.body }; } },

  { id: "chuva", nm: "Chuva", sky: SKY.rain,
    build: (u) => { const c = cloud(u, 50, 38, 66, CLOUD.grey, 1, 13);
      const r = rain([[24,56,20,.55],[38,62,24,.45],[52,54,22,.6],[66,64,18,.4],[80,58,20,.5],
        [31,78,16,.35],[59,80,15,.3],[74,84,13,.26]], "#DCEBF8");
      return { defs: c.defs, back: c.body + r }; } },

  { id: "tempestade", nm: "Tempestade", sky: SKY.storm,
    build: (u) => { const c = cloud(u, 50, 34, 70, CLOUD.storm, 1, 17);
      const b = bolt(u, 40, 46, 30, "#FFD54A");
      const r = rain([[20,58,20,.42],[74,60,20,.38],[28,82,14,.26],[80,84,13,.24]], "#BDD2E6");
      return { defs: c.defs + b.defs, back: c.body + b.body + r }; } },

  { id: "calor", nm: "Calor extremo", sky: SKY.heat,
    build: (u) => { const s = sun(u, 50, 44, 16, "#FFE14D", "#FF9E2C");
      return { defs: s.defs + blur(`hz-${u}`, 1.6),
        back: s.body +
          `<g filter="url(#hz-${u})" fill="none" stroke="#FFF6DC" stroke-linecap="round">` +
          '<path d="M 10 72 q 10 -8 20 0 t 20 0 t 20 0 t 20 0" stroke-width="4.2" opacity=".55"/>' +
          '<path d="M 6 84 q 10 -8 20 0 t 20 0 t 20 0 t 20 0" stroke-width="3.6" opacity=".45"/>' +
          '<path d="M 12 95 q 10 -8 20 0 t 20 0 t 20 0" stroke-width="3" opacity=".33"/></g>' }; } },

  { id: "amanhecer", nm: "Amanhecer", sky: SKY.dawn,
    build: (u) => { const s = sun(u, 50, 74, 13, "#FFE9A8", "#FF8A4C");
      const c1 = cloud(`${u}a`, 30, 46, 44, CLOUD.dawn, 0.92, 23);
      const c2 = cloud(`${u}b`, 74, 34, 32, CLOUD.dawn, 0.8, 29);
      return { defs: s.defs + c1.defs + c2.defs, back: s.body + c1.body + c2.body }; } },

  { id: "entardecer", nm: "Entardecer", sky: SKY.dusk,
    build: (u) => { const s = sun(u, 50, 80, 15, "#FFD37A", "#E8502A");
      const c1 = cloud(`${u}a`, 66, 44, 48, CLOUD.dusk, 0.95, 31);
      const c2 = cloud(`${u}b`, 24, 30, 34, CLOUD.dusk, 0.75, 37);
      return { defs: s.defs + c1.defs + c2.defs, back: s.body + c1.body + c2.body }; } },

  { id: "vento", nm: "Vento forte", sky: SKY.wind,
    build: (u) => { const w = wind(u); const c = cloud(u, 54, 24, 56, CLOUD.white, 0.8, 41);
      return { defs: w.defs + c.defs,
        back: `<g transform="translate(50 24) scale(1.22 0.86) translate(-50 -24)">${c.body}</g>` + w.body }; } },

  { id: "neblina", nm: "Neblina", sky: SKY.fog,
    build: (u) => { const f = fog(u); const c = cloud(u, 48, 30, 50, CLOUD.white, 0.55, 43);
      return { defs: f.defs + c.defs, back: c.body, front: f.body }; } },

  { id: "frio", nm: "Frio", sky: SKY.cold,
    build: (u) => { const c = cloud(u, 48, 28, 46, CLOUD.white, 0.95, 47);
      const big = snow([[24,60,3.2,.95],[44,74,2.6,.88],[64,64,3.4,.92],[80,82,2.4,.8],
        [34,90,2.2,.72],[70,96,2,.62]]);
      const halo = snow([[24,60,6.5,.22],[44,74,5.5,.18],[64,64,7,.2],[80,82,5,.15]]);
      return { defs: c.defs + blur(`sb-${u}`, 3.2),
        back: c.body + `<g filter="url(#sb-${u})">${halo}</g>` + big }; } },

  { id: "n-limpo", nm: "Noite de céu limpo", sky: SKY.night,
    build: (u) => { const m = moon(u, 68, 30, 13);
      const st = stars([[16,20,1.3,.95],[28,40,.8,.7],[12,54,1,.8],[40,16,1.1,.85],[52,44,.7,.6],
        [22,72,.9,.65],[88,58,1,.7],[36,62,.6,.5],[76,76,.8,.55],[6,34,.7,.6]]);
      return { defs: m.defs, back: st + m.body }; } },

  { id: "n-nublado", nm: "Noite nublada", sky: SKY.nightCloud,
    build: (u) => { const m = moon(u, 66, 26, 10);
      const st = stars([[18,18,1,.75],[34,32,.7,.55],[10,44,.8,.6]]);
      const c1 = cloud(`${u}a`, 42, 52, 56, CLOUD.night, 1, 53);
      const c2 = cloud(`${u}b`, 78, 66, 34, CLOUD.night, 0.9, 59);
      return { defs: m.defs + c1.defs + c2.defs, back: st + m.body + c2.body + c1.body }; } },

  { id: "n-chuva", nm: "Chuva à noite", sky: SKY.nightRain,
    build: (u) => { const m = moon(u, 80, 20, 8);
      const c = cloud(u, 46, 38, 62, CLOUD.night, 1, 61);
      const r = rain([[24,58,20,.5],[38,64,22,.42],[52,56,22,.52],[66,66,18,.38],[78,60,18,.44],
        [32,82,14,.3],[60,84,13,.26]], "#9FC6E6");
      return { defs: m.defs + c.defs, back: m.body + c.body + r }; } },

  { id: "n-tempestade", nm: "Tempestade noturna", sky: SKY.nightStorm,
    build: (u) => { const c = cloud(u, 50, 32, 72, CLOUD.night, 1, 67);
      const b = bolt(u, 40, 44, 32, "#FFE066");
      const r = rain([[20,60,20,.36],[74,62,20,.32],[30,84,14,.24]], "#8FB4D4");
      return { defs: c.defs + b.defs, back: c.body + b.body + r }; } },

  // A névoa engole o contorno da lua: só resta o brilho difuso. Reaproveitar a
  // cena de dia à noite colocaria um céu claro às três da manhã.
  { id: "n-neblina", nm: "Neblina à noite", sky: SKY.nightFog,
    build: (u) => { const gl = moonGlow(u, 64, 28, 30);
      const f = fog(u, "#C7D4E2");
      const c = cloud(u, 48, 30, 50, CLOUD.night, 0.5, 71);
      const st = stars([[18,16,.8,.45],[36,26,.6,.35]]);
      return { defs: gl.defs + f.defs + c.defs, back: st + gl.body + c.body, front: f.body }; } },

  { id: "n-frio", nm: "Frio à noite", sky: SKY.nightCold,
    build: (u) => { const m = moon(u, 74, 24, 9);
      const c = cloud(u, 44, 32, 44, CLOUD.night, 0.9, 73);
      const st = stars([[16,18,1,.7],[30,40,.7,.5],[90,48,.8,.55]]);
      const big = snow([[24,62,3,.9],[44,76,2.5,.82],[64,66,3.2,.88],[80,84,2.3,.74],
        [34,92,2,.66],[70,97,1.9,.58]]);
      const halo = snow([[24,62,6,.20],[44,76,5,.16],[64,66,6.5,.18],[80,84,4.6,.13]]);
      return { defs: m.defs + c.defs + blur(`sb-${u}`, 3.2),
        back: st + m.body + c.body + `<g filter="url(#sb-${u})">${halo}</g>` + big }; } },
];

/** Monta o SVG completo de uma cena. `uid` isola os ids quando há várias na mesma página. */
export function sceneSvg(scene, uid) {
  const u = uid || scene.id;
  const p = scene.build(u);
  return (
    `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${scene.nm}">` +
    "<defs>" +
    lg(`sky-${u}`, scene.sky, 0, 0, 0, 1) +
    `<radialGradient id="vig-${u}" cx=".5" cy=".45" r=".72">` +
    '<stop offset=".55" stop-color="#000000" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="#000000" stop-opacity=".42"/></radialGradient>' +
    `<clipPath id="cl-${u}"><circle cx="50" cy="50" r="50"/></clipPath>` +
    (p.defs || "") +
    "</defs>" +
    `<g clip-path="url(#cl-${u})">` +
    `<circle cx="50" cy="50" r="50" fill="url(#sky-${u})"/>` +
    (p.back || "") +
    (p.front || "") +
    `<circle cx="50" cy="50" r="50" fill="url(#vig-${u})"/>` +
    '<path d="M 13 30 A 46 46 0 0 1 87 30" fill="none" stroke="#FFFFFF" stroke-opacity=".10" stroke-width="2.4" stroke-linecap="round"/>' +
    "</g>" +
    '<circle cx="50" cy="50" r="49.4" fill="none" stroke="#000000" stroke-opacity=".22" stroke-width="1.2"/>' +
    "</svg>"
  );
}
