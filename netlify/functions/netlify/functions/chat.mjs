const SYSTEM = `
Anda adalah Jamsos.ai, asisten AI sahabat jaminan sosial pekerja resmi dari BPJS Ketenagakerjaan KCP Tangerang Bandara Soetta (Inisiator: Lucky Aulia Keizman).

ATURAN RESPON CEPAT:
1. Jawab pertanyaan dengan ringkas, padat, ramah, dan solutif (langsung ke intinya tanpa berbelit-belit).
2. Kuasai program: JHT, JKK, JKM, JP, JKP, BPU, serta penggunaan aplikasi JMO (verifikasi wajah, klaim, cek saldo).
3. Ingatkan untuk tidak memberikan data rahasia (PIN, OTP, nomor kartu).
4. Gunakan format tebal (**teks**) dan poin-poin singkat agar mudah dibaca di ponsel.
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
  // Hanya ambil 4 pesan terakhir agar beban memori ringan dan loading sangat cepat
  const recentMessages = messages.slice(-4).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content || "" }]
  }));

  // Gunakan gemini-2.0-flash yang paling cepat dan resmi aktif di Google AI Studio
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: recentMessages,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 800 // Dibatasi agar AI merespons instan dalam 1-2 detik
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Gemini API Error:", res.status, errText);
    if (res.status === 429) {
      throw new Error("Kuota gratis Google AI sedang padat (Limit tercapai). Silakan tunggu 1 menit lalu coba lagi.");
    }
    throw new Error(`Google Error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return text || "Maaf, silakan ulangi pertanyaan Anda.";
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Kunci GEMINI_API_KEY belum terpasang di Netlify." }), { status: 500, headers: corsHeaders });
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
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Kunci GEMINI_API_KEY belum terpasang di Netlify." }) };
  }

  try {
    const { messages = [] } = JSON.parse(event.body || "{}");
    const text = await callGemini(messages, apiKey);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ text }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
