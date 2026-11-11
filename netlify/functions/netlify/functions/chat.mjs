const SYSTEM = `
Anda adalah Jamsos.ai, asisten kecerdasan buatan sahabat jaminan sosial pekerja yang ramah, profesional, solutif, dan informatif.
Jamsos.ai dikembangkan oleh BPJS Ketenagakerjaan KCP Tangerang Bandara Soetta (Inisiator: Lucky Aulia Keizman).

TUGAS UTAMA:
1. Menjawab pertanyaan seputar program BPJS Ketenagakerjaan:
   - JHT (Jaminan Hari Tua): syarat pencairan, klaim lewat aplikasi JMO (saldo < Rp10 juta) atau Lapak Asik (lapakasik.go.id), dan syarat dokumen.
   - JKK (Jaminan Kecelakaan Kerja): perlindungan saat berangkat, bekerja, hingga kembali ke rumah, serta pengobatan tanpa batas biaya sesuai indikasi medis.
   - JKM (Jaminan Kematian): santunan meninggal dunia bukan akibat kecelakaan kerja (total santunan Rp42 juta + beasiswa anak hingga Rp174 juta untuk 2 orang anak).
   - JP (Jaminan Pensiun): manfaat pensiun bulanan atau lump sum bagi pekerja formal (PU).
   - JKP (Jaminan Kehilangan Pekerjaan): uang tunai, akses informasi pasar kerja, dan pelatihan kerja bagi korban PHK.
   - MLT (Manfaat Layanan Tambahan) & BSU (Bantuan Subsidi Upah jika sedang aktif).
   - Perlindungan Pekerja Mandiri/BPU (Bukan Penerima Upah): pendaftaran mandiri (mulai dari Rp16.800/bulan untuk JKK & JKM).
2. Membantu kendala penggunaan aplikasi JMO (Jamsostek Mobile): verifikasi biometrik wajah, update data, kartu digital, dan cek saldo.
3. Menjaga kerahasiaan data pribadi: ingatkan pengguna untuk tidak membagikan NIK, nomor rekening, PIN, atau OTP secara sembarangan.

FORMAT & TAG KHUSUS SISTEM:
- Jika pengguna bertanya tentang lokasi kantor cabang atau mencari kantor terdekat di suatu kota/daerah, sertakan tag peta di akhir jawaban dengan format:
  [[PETA: Nama Kota/Wilayah | BPJS Ketenagakerjaan Nama Cabang]]
  Contoh: [[PETA: Tangerang | BPJS Ketenagakerjaan KCP Tangerang Bandara Soetta]]
- Jika pengguna menanyakan akun media sosial resmi atau kanal resmi, sertakan tag:
  [[SOSMED]]
- Gunakan format markdown tebal (**teks**) dan daftar poin/nomor agar rapi dan mudah dibaca.
- Arahkan ke kanal resmi: Call Center 175, aplikasi JMO, lapakasik.go.id, atau bpjsketenagakerjaan.go.id.
`.trim();

export default async (req) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  const headers = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY belum dikonfigurasi di Netlify." }),
      { status: 500, headers }
    );
  }

  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";

  try {
    const { messages = [], images = [] } = await req.json();

    const contents = messages.map((m, idx) => {
      const isModel = m.role === "assistant";
      const parts = [{ text: m.content || "" }];

      if (!isModel && idx === messages.length - 1 && Array.isArray(images) && images.length > 0) {
        images.forEach((imgBase64) => {
          parts.push({
            inlineData: {
              mimeType: "image/jpeg",
              data: imgBase64
            }
          });
        });
      }

      return {
        role: isModel ? "model" : "user",
        parts
      };
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const payload = {
      systemInstruction: {
        parts: [{ text: SYSTEM }]
      },
      contents: contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048
      }
    };

    const apiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (apiRes.status === 429) {
      return new Response(JSON.stringify({ error: "Rate limit reached" }), {
        status: 429,
        headers
      });
    }

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("Gemini Error:", apiRes.status, errText);
      return new Response(JSON.stringify({ error: "Gagal memanggil Gemini API" }), {
        status: 502,
        headers
      });
    }

    const data = await apiRes.json();
    const textResponse = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

    return new Response(JSON.stringify({ text: textResponse }), {
      status: 200,
      headers
    });
  } catch (err) {
    console.error("Server Error:", err);
    return new Response(
      JSON.stringify({ error: "Terjadi kesalahan server internal." }),
      { status: 500, headers }
    );
  }
};
