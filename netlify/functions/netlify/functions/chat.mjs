const SYSTEM = `
Anda adalah Jamsos.ai, asisten AI sahabat jaminan sosial pekerja resmi dari BPJS Ketenagakerjaan KCP Tangerang Bandara Soetta (Inisiator: Lucky Aulia Keizman).

ATURAN RESPON CEPAT:
1. Jawab pertanyaan dengan ringkas, padat, ramah, dan solutif (langsung ke intinya).
2. Kuasai program: JHT, JKK, JKM, JP, JKP, MLT, BPU, serta aplikasi JMO.
3. Ingatkan untuk tidak memberikan data rahasia (PIN, OTP).
4. Gunakan format tebal (**teks**) dan poin-poin agar rapi.
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
  const recentMessages = messages.slice(-4).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content || "" }]
  }));

  // Menggunakan alias resmi gemini-flash-latest yang aktif di Google AI Studio
  const models = [
    process.env.GEMINI_MODEL,
    "gemini-flash-latest",
    "gemini-2.5-flash"
  ].filter(Boolean);

  let lastError = "";

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: recentMessages,
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 800
        }
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

  throw new Error(lastError || "Gagal memanggil model Google.");
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
