// Cinematic shots for the Even ad, generated with Veo 3.1 through the Gemini API.
//
//   export GEMINI_API_KEY=...            (your key; never written anywhere by this script)
//   node promo/veo.mjs list              shot list and cost table, no API call
//   node promo/veo.mjs A                 one shot, Veo 3.1 Fast, 1 take   (asks before spending)
//   node promo/veo.mjs A,C --takes 2     several shots, 2 takes each
//   node promo/veo.mjs all --model standard
//   node promo/veo.mjs A --yes           skip the cost prompt
//
// Output: promo/veo/<shot>-<model>-<n>.mp4 (8 s, 1080p, 16:9, with Veo's own sound).
// Prices (ai.google.dev/gemini-api/docs/pricing, 1080p, per second of video): lite $0.08, fast $0.12,
// standard $0.40. Google charges only for videos that are generated.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, "veo");
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODELS = {
  lite: { id: "veo-3.1-lite-generate-preview", usdPerSec: 0.08 },
  fast: { id: "veo-3.1-fast-generate-preview", usdPerSec: 0.12 },
  standard: { id: "veo-3.1-generate-preview", usdPerSec: 0.4 },
};
const SECONDS = 8;

// One look for every shot, so the cuts match the code-rendered beats and the site.
const LOOK =
  "Cinematic, anamorphic 2.39:1 framing feel, shallow depth of field, volumetric haze, " +
  "soft bloom on neon. World: a vast night-time arcade city built from glowing maze corridors, " +
  "deep indigo (#200052) darkness, neon purple walls (#6E54FF, #8270FF), lime-green light accents (#C6F24E), " +
  "magenta-pink danger light (#E0358F). The hero is a chunky purple pixel-art coin with a light purple rim, " +
  "two glowing lime equals-sign eyes and a small smile, rendered as a physical 3D voxel object. " +
  "Film grain, smooth deliberate camera, no handheld shake.";
const NEGATIVE =
  "text, letters, words, numbers, subtitles, captions, watermark, logo, brand names, yellow, ghosts, " +
  "pac-man, pie-shaped characters, humans, faces of people, gore, blurry, low quality, cartoon flat 2D";

const SHOTS = {
  A: {
    title: "Cold open: the coin wakes up",
    first: "frames/coin-16x9.png",
    prompt:
      "Start on this exact pixel coin, dark and powered off in near-total darkness. A low electrical hum. " +
      "Its equals-sign eyes flicker and ignite in lime green, light spilling onto wet maze floor tiles. " +
      "Slow dolly back and crane up reveals an endless neon maze city stretching to the horizon under a purple sky. " +
      "Deep sub-bass swell, a single arcade chime as the eyes light. " + LOOK,
  },
  B: {
    title: "The race: the bot is gone before the crowd arrives",
    ref: "frames/coin-16x9.png",
    prompt:
      "Low tracking shot at ground level along a long neon maze corridor. A sleek magenta-pink pixel robot with a white " +
      "visor and a single antenna bursts off a starting line in a streak of pink light, scooping up a line of glowing " +
      "pellets before anyone else moves. Behind it, in slow motion, a crowd of small purple pixel coins (like the reference) " +
      "only just starting to roll, left far behind, the pellets already gone. Speed ramp from real time to slow motion. " +
      "Whoosh, rising tension, distant crowd murmur. " + LOOK,
  },
  C: {
    title: "Sealed bids: everyone drops a sealed coin into the vault",
    ref: "frames/coin-16x9.png",
    prompt:
      "Wide shot of a monumental arcade vault in the middle of the neon maze city: a tall dark machine with a single " +
      "glowing coin slot. From every corridor, purple pixel coins (like the reference) and one pink pixel robot arrive and " +
      "each drops a sealed glowing purple capsule into the slot at the same time; each capsule clicks shut with a lime " +
      "lock light. A huge analog countdown dial on the vault ticks down to zero and the slot closes. Slow push-in. " +
      "Heavy mechanical clunks, ticking, tension holding. " + LOOK,
  },
  D: {
    title: "The reveal: everyone lands on the same step",
    ref: "frames/coin-16x9.png",
    prompt:
      "The vault doors swing open and warm lime light pours out across the maze city. A giant glowing staircase of " +
      "purple steps rises from the floor. All the purple pixel coins (like the reference) and the pink robot rise together " +
      "and land at exactly the same height on one single step, which lights up bright lime under all of them at once. " +
      "Nobody higher, nobody lower. Slow crane up and orbit around the group. Triumphant swell, a satisfying unified " +
      "chime as they land. " + LOOK,
  },
  E: {
    title: "Closer: the coin rolls into the end card",
    first: "frames/coin-16x9.png",
    last: "frames/end-card.png",
    prompt:
      "The pixel coin turns toward camera, smiles, and rolls forward into the light; the scene resolves smoothly into " +
      "the final title card exactly as in the last frame, holding still at the end. Gentle arcade chime, music resolves. " +
      LOOK,
  },
};

function inline(rel) {
  const p = path.join(OUT, rel);
  return { inlineData: { mimeType: "image/png", data: fs.readFileSync(p).toString("base64") } };
}

async function api(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json", ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body.error || body).slice(0, 400)}`);
  return body;
}

async function generate(key, model, take) {
  const s = SHOTS[key];
  const instance = { prompt: s.prompt };
  if (s.first) instance.image = inline(s.first);
  if (s.last) instance.lastFrame = inline(s.last);
  if (s.ref && !s.first) instance.referenceImages = [{ image: inline(s.ref), referenceType: "asset" }];
  const body = {
    instances: [instance],
    parameters: { aspectRatio: "16:9", resolution: "1080p", durationSeconds: String(SECONDS), negativePrompt: NEGATIVE },
  };
  let op;
  try {
    op = await api(`${BASE}/models/${MODELS[model].id}:predictLongRunning`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    // Some models take no reference images; retry once with the prompt alone.
    if (!instance.referenceImages) throw e;
    console.log(`  ${key}: reference image refused (${e.message.slice(0, 120)}), retrying without it`);
    delete instance.referenceImages;
    op = await api(`${BASE}/models/${MODELS[model].id}:predictLongRunning`, { method: "POST", body: JSON.stringify(body) });
  }
  process.stdout.write(`  ${key} take ${take}: queued `);
  while (!op.done) {
    await new Promise((r) => setTimeout(r, 10000));
    process.stdout.write(".");
    op = await api(`${BASE}/${op.name}`);
  }
  if (op.error) throw new Error(JSON.stringify(op.error));
  const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!uri) throw new Error(`no video in response: ${JSON.stringify(op.response).slice(0, 400)}`);
  const vid = await fetch(uri, { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY }, redirect: "follow" });
  if (!vid.ok) throw new Error(`download ${vid.status}`);
  const file = path.join(OUT, `${key}-${model}-${take}.mp4`);
  fs.writeFileSync(file, Buffer.from(await vid.arrayBuffer()));
  console.log(` saved ${path.relative(process.cwd(), file)}`);
}

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : args[i + 1]; };
const what = args[0] || "list";
const model = opt("model", "fast");
const takes = Number(opt("takes", 1));
if (!MODELS[model]) throw new Error(`model must be one of ${Object.keys(MODELS).join(", ")}`);

if (what === "list") {
  for (const [k, s] of Object.entries(SHOTS)) console.log(`${k}  ${s.title}`);
  console.log("\nPer 8-second take at 1080p:");
  for (const [m, v] of Object.entries(MODELS)) console.log(`  ${m.padEnd(9)} $${(v.usdPerSec * SECONDS).toFixed(2)}`);
  process.exit(0);
}

const keys = what === "all" ? Object.keys(SHOTS) : what.split(",").map((k) => k.trim().toUpperCase());
for (const k of keys) if (!SHOTS[k]) throw new Error(`unknown shot ${k}; run: node promo/veo.mjs list`);
if (!process.env.GEMINI_API_KEY) throw new Error("set GEMINI_API_KEY in this terminal first");

const cost = keys.length * takes * SECONDS * MODELS[model].usdPerSec;
console.log(`${keys.join(", ")} × ${takes} take(s) on ${MODELS[model].id} ≈ $${cost.toFixed(2)}`);
if (!args.includes("--yes")) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = (await rl.question("Generate? [y/N] ")).trim().toLowerCase() === "y";
  rl.close();
  if (!ok) process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
for (const k of keys) {
  for (let t = 1; t <= takes; t++) {
    let n = t;
    while (fs.existsSync(path.join(OUT, `${k}-${model}-${n}.mp4`))) n++;
    try { await generate(k, model, n); } catch (e) { console.log(`\n  ${k}: failed: ${e.message}`); }
  }
}
