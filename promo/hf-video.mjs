// Pixel-art shots for the Even commercial, generated through Hugging Face Inference Providers
// (routed to fal.ai, billed to your Hugging Face credits at fal's own prices, no markup).
//
//   export HF_TOKEN=hf_...            a token with the "Inference Providers" permission; never stored
//   node promo/hf-video.mjs list                shot list and cost, no API call
//   node promo/hf-video.mjs A                   one shot, Wan 2.2, 720p, 5 s   (asks before spending)
//   node promo/hf-video.mjs A,C --takes 2       two takes each
//   node promo/hf-video.mjs all --model ltx     LTX-2 instead of Wan 2.2 (has sound, ~5 s)
//   node promo/hf-video.mjs all --res 480p      cheaper draft pass
//   node promo/hf-video.mjs all --yes           skip the cost prompt
//
// Output: promo/veo/<shot>-<model>-<n>.mp4. Only models with a Hub page can be routed through
// Hugging Face, so Veo and Seedance are not available here; Wan 2.2 (14B) and LTX-2 are.
// Prices (fal.ai, Oct 2026): Wan 2.2 image-to-video $0.08 per second at 720p, $0.06 at 580p,
// $0.04 at 480p. LTX-2 distilled is about $0.04–0.06 per second (fal lists LTX-2.3 Fast at $0.04).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "veo");
const ROUTER = "https://router.huggingface.co/fal-ai";
const MODELS = {
  wan: { id: "fal-ai/wan/v2.2-a14b/image-to-video", fps: 16, usdPerSec: { "480p": 0.04, "580p": 0.06, "720p": 0.08 } },
  ltx: { id: "fal-ai/ltx-2-19b/distilled/image-to-video", fps: 25, usdPerSec: { "720p": 0.05, "1080p": 0.05 } },
};

// 16-bit arcade look, the same for every shot so the cuts match the site and the code-rendered beats.
const LOOK =
  "16-bit pixel art arcade game, crisp pixels, limited palette: deep indigo background (#200052), neon purple maze " +
  "walls (#6E54FF), lime green (#C6F24E) pellets and lights, magenta pink (#E0358F) for the rival. Subtle CRT scanlines. " +
  "Smooth 2D side-scrolling game animation, sprites move on a grid. No text, no letters, no numbers.";
const NEGATIVE =
  "text, letters, words, numbers, subtitles, watermark, logo, yellow, ghosts, pac-man, pie-shaped mouth, humans, " +
  "photorealistic, 3D render, blurry, smeared pixels, flicker";

const SHOTS = {
  A: {
    title: "Attract mode: the coin wakes up in the maze",
    first: "frames/maze-16x9.png",
    prompt:
      "The purple pixel coin with glowing lime equals-sign eyes sits still in a neon maze corridor. Its eyes blink on, " +
      "it bobs once, then rolls forward along the corridor eating a line of lime pellets one by one, each pellet " +
      "vanishing with a small sparkle. The camera scrolls sideways to follow it. Walls glow softly. " + LOOK,
  },
  B: {
    title: "The old game: the pink robot clears the maze before the coins move",
    first: "frames/maze-16x9.png",
    prompt:
      "A magenta pink pixel robot with a white visor and one antenna dashes through the neon maze at high speed, " +
      "leaving a pink motion trail and eating every lime pellet in its path. Behind it, several small purple pixel " +
      "coins with lime equals-sign eyes are only just starting to move and find the corridors already empty; they " +
      "stop and dim to grey one by one. Side-scrolling camera. " + LOOK,
  },
  C: {
    title: "Insert coin: everyone drops a sealed capsule into one slot, lights out",
    first: "frames/maze-16x9.png",
    prompt:
      "In the middle of the neon maze stands a tall dark arcade vault with a single glowing slot. Purple pixel coins " +
      "with lime equals-sign eyes and one magenta pink pixel robot arrive from every corridor and each drops a small " +
      "sealed purple capsule into the slot; each capsule locks with a lime click light. Then every maze light switches " +
      "off, leaving only the slot glowing in the dark. Static camera. " + LOOK,
  },
  D: {
    title: "Continue?: the vault opens and everyone lands on the same step",
    first: "frames/maze-16x9.png",
    prompt:
      "The maze lights come back on and a staircase of purple pixel steps rises from the floor. All the purple pixel " +
      "coins with lime equals-sign eyes and the magenta pink pixel robot jump together and all land on exactly the " +
      "same step at the same moment; that one step lights up bright lime under all of them. A lime horizontal light " +
      "line sweeps across the screen at the height of that step. Camera slowly pulls back. " + LOOK,
  },
  E: {
    title: "Press start: the logo lands",
    first: "frames/coin-16x9.png",
    last: "frames/logo-16x9.png",
    prompt:
      "The voxel purple coin with glowing lime equals-sign eyes spins once toward the camera, smiles, and drops down " +
      "to land with a soft bounce as the full logo settles into place and holds still. Dark indigo background, " +
      "subtle CRT scanlines, soft lime glow. No extra text beyond what is in the final frame.",
  },
};

const dataUri = (rel) => {
  const p = path.join(OUT, rel);
  return `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
};

async function hf(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

async function generate(key, model, res, seconds, take) {
  const s = SHOTS[key];
  const m = MODELS[model];
  const body = { prompt: s.prompt, image_url: dataUri(s.first), negative_prompt: NEGATIVE };
  if (s.last) body.end_image_url = dataUri(s.last);
  if (model === "wan") {
    Object.assign(body, {
      resolution: res, aspect_ratio: "16:9", num_frames: Math.min(161, Math.round(seconds * 16) + 1),
      frames_per_second: 16, interpolator_model: "none", enable_prompt_expansion: false,
      enable_safety_checker: false, enable_output_safety_checker: false,
    });
  } else {
    Object.assign(body, {
      num_frames: Math.round(seconds * 25) + 1, fps: 25, generate_audio: true, camera_lora: "static",
      enable_prompt_expansion: false, video_size: { width: 1920, height: 1080 },
    });
  }
  const queued = await hf(`${ROUTER}/${m.id}?_subdomain=queue`, { method: "POST", body: JSON.stringify(body) });
  const id = queued.request_id;
  const reqPath = new URL(queued.response_url || queued.status_url).pathname.replace(/\/status$/, "");
  process.stdout.write(`  ${key} take ${take} (${id.slice(0, 8)}): queued `);
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await hf(`${ROUTER}${reqPath}/status?_subdomain=queue`);
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.error) throw new Error(JSON.stringify(st).slice(0, 300));
    process.stdout.write(".");
  }
  const result = await hf(`${ROUTER}${reqPath}?_subdomain=queue`);
  const url = result.video?.url;
  if (!url) throw new Error(`no video in result: ${JSON.stringify(result).slice(0, 300)}`);
  const vid = await fetch(url);
  if (!vid.ok) throw new Error(`download ${vid.status}`);
  const file = path.join(OUT, `${key}-${model}-${take}.mp4`);
  fs.writeFileSync(file, Buffer.from(await vid.arrayBuffer()));
  console.log(` saved ${path.relative(process.cwd(), file)}`);
}

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : args[i + 1]; };
const what = args[0] || "list";
const model = opt("model", "wan");
const res = opt("res", model === "wan" ? "720p" : "1080p");
const seconds = Number(opt("seconds", 5));
const takes = Number(opt("takes", 1));
if (!MODELS[model]) throw new Error(`model must be one of ${Object.keys(MODELS).join(", ")}`);
if (!MODELS[model].usdPerSec[res]) throw new Error(`res must be one of ${Object.keys(MODELS[model].usdPerSec).join(", ")}`);

if (what === "list") {
  for (const [k, s] of Object.entries(SHOTS)) console.log(`${k}  ${s.title}`);
  console.log("\nPer 5-second take:");
  for (const [mk, mv] of Object.entries(MODELS)) for (const [r, p] of Object.entries(mv.usdPerSec)) console.log(`  ${mk} ${r.padEnd(6)} $${(p * 5).toFixed(2)}`);
  process.exit(0);
}

const keys = what === "all" ? Object.keys(SHOTS) : what.split(",").map((k) => k.trim().toUpperCase());
for (const k of keys) if (!SHOTS[k]) throw new Error(`unknown shot ${k}; run: node promo/hf-video.mjs list`);
if (!process.env.HF_TOKEN) throw new Error("set HF_TOKEN in this terminal first");

const cost = keys.length * takes * seconds * MODELS[model].usdPerSec[res];
console.log(`${keys.join(", ")} × ${takes} take(s), ${seconds}s each on ${MODELS[model].id} at ${res} ≈ $${cost.toFixed(2)} of HF credits`);
if (!args.includes("--yes")) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = (await rl.question("Generate? [y/N] ")).trim().toLowerCase() === "y";
  rl.close();
  if (!ok) process.exit(0);
}
for (const k of keys) {
  for (let t = 1; t <= takes; t++) {
    let n = t;
    while (fs.existsSync(path.join(OUT, `${k}-${model}-${n}.mp4`))) n++;
    try { await generate(k, model, res, seconds, n); } catch (e) { console.log(`\n  ${k}: failed: ${e.message}`); }
  }
}
