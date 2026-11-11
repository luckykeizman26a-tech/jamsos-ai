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

async function callGemini(messages, apiKey) {
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content || "" }]
  }));

  // Daftar model aktif Google (memprioritaskan 2.0-flash yang didukung Google saat ini)
  const models = [
    process.env.GEMINI_MODEL,
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-flash-latest"
  ].filter(Boolean);

  let lastError = "";

  for (const model of models) {
    try {
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

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (text) return text;
      } else {
        const errText = await res.text();
        console.warn(`Percobaan model ${model} gagal (${res.status}): ${errText}`);
        lastError = errText;
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  throw new Error(lastError || "Semua model gagal merespons");
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
