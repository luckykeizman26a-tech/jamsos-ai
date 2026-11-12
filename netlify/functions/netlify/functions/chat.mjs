// netlify/functions/chat.mjs
// Jamsos.Ai - Netlify Function (v2) untuk Gemini API.
// Kontrak dengan frontend (TIDAK berubah dari versi lama):
//   Request : POST { "messages": [ { "role": "user" | "assistant", "content": "..." }, ... ] }
//   Sukses  : 200 { "text": "..." }
//   Gagal   : 4xx/5xx { "error": "pesan ramah untuk pengunjung" }
//
// Environment variable di Netlify:
//   GEMINI_API_KEY  (wajib)
//   GEMINI_MODELS   (opsional) daftar model dipisah koma, urutan = prioritas
//   ALLOWED_ORIGIN  (opsional) default https://aisoetta.netlify.app
// CATATAN: variabel lama GEMINI_MODEL (tanpa S) tidak dipakai lagi. Hapus dari Netlify.

const SYSTEM = `
Anda adalah Jamsos.ai, asisten AI sahabat jaminan sosial pekerja resmi dari BPJS Ketenagakerjaan KCP Tangerang Bandara Soetta (Inisiator: Lucky Aulia Keizman).

ATURAN RESPON:
1. Jawab pertanyaan dengan ringkas, padat, ramah, dan solutif.
2. Kuasai program: JHT, JKK, JKM, JP, JKP, MLT, BPU, serta aplikasi JMO.
3. Ingatkan untuk tidak memberikan data rahasia (PIN, OTP).
4. Gunakan format tebal (**teks**) dan poin-poin agar rapi.
5. Jika ditanya lokasi kantor cabang/terdekat, sertakan tag:
   [[PETA: Nama Kota/Wilayah | BPJS Ketenagakerjaan Nama Cabang]]
6. Jika ditanya media sosial resmi, sertakan tag:
   [[SOSMED]]
`.trim();

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Alias "-latest" menunjuk ke versi terbaru. Kuota dihitung per model, jadi
// model "lite" memberi cadangan jatah harian yang terpisah (verifikasi di AI Studio).
const DEFAULT_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 6;

// Netlify membatasi fungsi sinkron sekitar 10 detik; sisakan ruang aman.
const TOTAL_BUDGET_MS = 8500;
const PER_ATTEMPT_MS = 6500;

// Pembatasan per IP (best-effort: memori hanya per instance fungsi).
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

const MSG_BUSY =
  "Jamsos.Ai sedang melayani banyak permintaan. Silakan coba lagi beberapa saat lagi, atau hubungi kanal resmi BPJS Ketenagakerjaan.";
const MSG_QUOTA =
  "Batas layanan harian Jamsos.Ai sedang tercapai. Silakan coba lagi nanti, atau hubungi kanal resmi BPJS Ketenagakerjaan.";
const MSG_CONFIG = "Layanan sedang dalam perbaikan. Silakan coba lagi nanti.";

// ---------- State di memori ----------
const blockedUntil = new Map(); // model -> timestamp ms
const hits = new Map(); // ip -> [timestamps]
let modelCache = { list: null, at: 0 };

// ---------- Utilitas ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://aisoetta.netlify.app",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), ...extra },
  });
}

function getIp(req, context) {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    context?.ip ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function isRateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) hits.delete(k);
    }
  }
  return arr.length > RATE_LIMIT_MAX;
}

function cleanModelName(name) {
  return String(name || "").trim().replace(/^models\//, "");
}

function getCandidateModels() {
  const fromEnv = (process.env.GEMINI_MODELS || "")
    .split(",")
    .map(cleanModelName)
    .filter((m) => /^[a-z0-9.\-]+$/i.test(m));
  return [...new Set(fromEnv.length ? fromEnv : DEFAULT_MODELS)];
}

function buildContents(messages) {
  const list = Array.isArray(messages) ? messages.slice(-MAX_HISTORY_MESSAGES) : [];
  const contents = [];
  for (const m of list) {
    const text = String(m?.content ?? m?.text ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text) continue;
    const role = ["assistant", "model", "bot"].includes(m?.role) ? "model" : "user";
    contents.push({ role, parts: [{ text }] });
  }
  // Gemini mengharapkan percakapan diawali giliran user.
  while (contents.length && contents[0].role !== "user") contents.shift();
  return contents;
}

function parseRetrySeconds(errText) {
  try {
    const details = JSON.parse(errText)?.error?.details || [];
    const info = details.find((d) => String(d["@type"] || "").includes("RetryInfo"));
    if (info?.retryDelay) return Math.ceil(parseFloat(info.retryDelay)) || 60;
  } catch {}
  const m = /retry in ([\d.]+)s/i.exec(errText || "");
  return m ? Math.ceil(parseFloat(m[1])) : 60;
}

function extractReply(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts.map((p) => p?.text || "").join("").trim();
    if (text) return text;
  }
  return "";
}

// ---------- Panggilan ke Gemini ----------
async function callGemini(model, contents, timeoutMs, apiKey) {
  const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey, // header, bukan URL, agar key tidak muncul di log
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      generationConfig: { temperature: 0.6, maxOutputTokens: 800 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text(); // dibaca sekali saja
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {}
  return { ok: res.ok, status: res.status, raw, data };
}

async function discoverModels(apiKey) {
  const now = Date.now();
  if (modelCache.list && now - modelCache.at < 3_600_000) return modelCache.list;
  try {
    const res = await fetch(`${API_BASE}/models?pageSize=100`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => cleanModelName(m.name))
      .filter((n) => /flash/.test(n))
      .filter((n) => !/(image|tts|audio|live|embedding|robotics|computer|exp)/.test(n))
      .sort()
      .reverse()
      .slice(0, 4);
    modelCache = { list, at: now };
    return list;
  } catch {
    return [];
  }
}

// Mencoba model berurutan. Hasil: { reply, model } | { fatal } | null
async function runModels(models, contents, state, apiKey) {
  for (const model of models) {
    if (state.tried.has(model)) continue;
    if ((blockedUntil.get(model) || 0) > Date.now()) continue;
    state.tried.add(model);

    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - state.start);
      if (remaining < 1200) return null;

      let r;
      try {
        r = await callGemini(model, contents, Math.min(PER_ATTEMPT_MS, remaining), apiKey);
      } catch (e) {
        console.warn(`[chat] ${model} timeout/jaringan: ${e?.name || e}`);
        break;
      }

      if (r.ok) {
        const reply = extractReply(r.data);
        if (reply) return { reply, model };
        const block = r.data?.promptFeedback?.blockReason;
        const finish = r.data?.candidates?.[0]?.finishReason;
        console.warn(`[chat] ${model} balasan kosong (${block || finish || "tanpa alasan"})`);
        if (block || finish === "SAFETY") {
          return {
            reply: "Maaf, pertanyaan tersebut tidak dapat saya jawab. Silakan ajukan pertanyaan lain seputar BPJS Ketenagakerjaan.",
            model,
          };
        }
        break;
      }

      console.warn(`[chat] ${model} gagal (${r.status}): ${r.raw.slice(0, 300)}`);

      if (r.status === 404) {
        blockedUntil.set(model, Date.now() + 6 * 3_600_000);
        state.sawNotFound = true;
        break;
      }
      if (r.status === 429) {
        const isDaily = /PerDay/i.test(r.raw);
        const wait = isDaily ? 3600 : parseRetrySeconds(r.raw) + 1;
        blockedUntil.set(model, Date.now() + wait * 1000);
        state.quota = true;
        state.retryAfter = Math.max(state.retryAfter || 0, wait);
        break;
      }
      if (r.status === 401 || r.status === 403 || (r.status === 400 && /API key/i.test(r.raw))) {
        return { fatal: "API key bermasalah (tidak valid, dinonaktifkan, atau dibatasi)." };
      }
      if ([500, 502, 503, 504].includes(r.status)) {
        if (attempt === 0) {
          await sleep(700);
          continue;
        }
        break;
      }
      break;
    }
  }
  return null;
}

// ---------- Handler utama ----------
export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") {
    return json(405, { error: "Metode tidak diizinkan." }, { Allow: "POST" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[chat] GEMINI_API_KEY belum diatur di Netlify.");
    return json(500, { error: MSG_CONFIG });
  }

  if (isRateLimited(getIp(req, context))) {
    return json(429, { error: "Terlalu banyak pesan dalam waktu singkat. Mohon tunggu sebentar." }, { "Retry-After": "60" });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Format permintaan tidak valid." });
  }

  const contents = buildContents(body?.messages);
  if (!contents.length || contents[contents.length - 1].role !== "user") {
    return json(400, { error: "Pesan tidak boleh kosong." });
  }

  const state = { start: Date.now(), tried: new Set() };
  let result = await runModels(getCandidateModels(), contents, state, apiKey);

  // Jika ada nama model yang 404, cari model yang benar-benar tersedia untuk key ini.
  if (!result && state.sawNotFound) {
    const discovered = await discoverModels(apiKey);
    if (discovered.length) result = await runModels(discovered, contents, state, apiKey);
  }

  if (result?.reply) return json(200, { text: result.reply, model: result.model });

  if (result?.fatal) {
    console.error(`[chat] FATAL: ${result.fatal}`);
    return json(500, { error: MSG_CONFIG });
  }

  if (state.quota) {
    return json(429, { error: MSG_QUOTA }, { "Retry-After": String(state.retryAfter || 60) });
  }
  return json(503, { error: MSG_BUSY }, { "Retry-After": "30" });
};
