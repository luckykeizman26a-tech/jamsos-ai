const SYSTEM = `
Anda adalah Jamsos.ai, asisten kecerdasan buatan sahabat jaminan sosial pekerja yang ramah, profesional, solutif, dan informatif.
Jamsos.ai dikembangkan oleh BPJS Ketenagakerjaan KCP Tangerang Bandara Soetta (Inisiator: Lucky Aulia Keizman).

TUGAS UTAMA:
1. Menjawab pertanyaan seputar program BPJS Ketenagakerjaan (JHT, JKK, JKM, JP, JKP, MLT, BPU).
2. Membantu kendala penggunaan aplikasi JMO (verifikasi wajah, update data, cek saldo).
3. Menjaga kerahasiaan data pribadi (jangan bagikan NIK, PIN, OTP).
4. Gunakan format markdown tebal (**teks**) dan daftar poin agar rapi.
5. Jika ditanya lokasi kantor cabang/terdekat, sertakan tag:
   [[PETA: Nama Kota/Wilayah | BPJS Ketenagakerjaan Nama Cabang]]
6. Jika ditanya media sosial resmi, sertakan tag:
   [[SOSMED]]
`.trim();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

let cachedModel = null;

// Otomatis mendeteksi model Gemini yang tersedia dan aktif di akun Google Anda
async function getAvailableModel(apiKey) {
  if (cachedModel) return cachedModel;

  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (listRes.ok) {
      const data = await listRes.json();
      const available = data.models
        ?.filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        ?.map((m) => m.name.replace(/^models\//, "")) || [];

      // Cari model flash terbaru yang aktif di akun Anda
      const chosen = available.find((m) => m.includes("2.0-flash")) ||
                     available.find((m) => m.includes("flash")) ||
                     available[0];

      if (chosen) {
        cachedModel = chosen;
        console.log("Model Gemini yang berhasil terdeteksi:", cachedModel);
        return cachedModel;
      }
    }
  } catch (err) {
    console.warn("Gagal mendeteksi daftar model, menggunakan fallback:", err);
  }

  // Fallback standar
  return "gemini-2.0-flash";
}

async function callGemini(messages, apiKey) {
  const model = await getAvailableModel(apiKey);

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content || "" }]
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Gemini API Error:", res.status, errText);
    throw new Error(`Gemini Error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return text;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY missing" }), { status: 500, headers: corsHeaders });
  }

  try {
    const { messages = [] } = await req.json();
    const text = await callGemini(messages, apiKey);
    return new Response(JSON.stringify({ text }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "Method not allowed" }) };

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "GEMINI_API_KEY missing" }) };
  }

  try {
    const { messages = [] } = JSON.parse(event.body || "{}");
    const text = await callGemini(messages, apiKey);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ text }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
