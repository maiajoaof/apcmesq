require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Apenas arquivos PDF são aceitos"));
  },
});

app.use(express.static(path.join(__dirname, "public")));

function getPageCount(pdfPath) {
  try {
    const out = execSync(`pdfinfo "${pdfPath}"`, { timeout: 10000 }).toString();
    const match = out.match(/Pages:\s*(\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch { return 0; }
}

function extractTextFromPdf(buffer) {
  const id = Date.now();
  const tmpPdf = path.join(os.tmpdir(), `proc_${id}.pdf`);
  const tmpDir = path.join(os.tmpdir(), `proc_ocr_${id}`);

  try {
    fs.writeFileSync(tmpPdf, buffer);

    const totalPages = getPageCount(tmpPdf);
    if (totalPages === 0) throw new Error("Não foi possível determinar o número de páginas");

    console.log(`PDF com ${totalPages} páginas — processando página a página...`);

    let fullText = "";
    let nativeCount = 0;
    let ocrCount = 0;

    fs.mkdirSync(tmpDir, { recursive: true });

    for (let p = 1; p <= totalPages; p++) {
      // Tenta extração nativa da página
      let pageText = "";
      try {
        pageText = execSync(
          `pdftotext -f ${p} -l ${p} "${tmpPdf}" -`,
          { timeout: 10000 }
        ).toString().trim();
      } catch {}

      if (pageText.length >= 20) {
        fullText += pageText + "\n\n";
        nativeCount++;
        continue;
      }

      // Página sem texto — aplica OCR
      const imgBase = path.join(tmpDir, `p${p}`);
      try {
        execSync(
          `pdftoppm -f ${p} -l ${p} -r 200 -png "${tmpPdf}" "${imgBase}"`,
          { timeout: 30000 }
        );
        const imgFiles = fs.readdirSync(tmpDir)
          .filter(f => f.startsWith(`p${p}-`) || f === `p${p}.png`)
          .filter(f => f.endsWith(".png"));

        for (const img of imgFiles) {
          const imgPath = path.join(tmpDir, img);
          const outBase = imgPath.replace(".png", "_out");
          try {
            execSync(
              `tesseract "${imgPath}" "${outBase}" -l por --psm 1 quiet`,
              { timeout: 60000 }
            );
            const ocrText = fs.readFileSync(`${outBase}.txt`, "utf8").trim();
            if (ocrText.length >= 20) {
              fullText += ocrText + "\n\n";
              ocrCount++;
            }
          } catch {}
          try { fs.unlinkSync(imgPath); } catch {}
          try { fs.unlinkSync(`${outBase}.txt`); } catch {}
        }
      } catch (e) {
        console.warn(`Página ${p} — OCR falhou: ${e.message}`);
      }
    }

    console.log(`Extração: ${nativeCount} nativas, ${ocrCount} OCR, ${fullText.length} chars`);

    if (fullText.trim().length < 100) throw new Error("Nenhum texto extraído do documento");

    return fullText.trim();

  } finally {
    try { fs.unlinkSync(tmpPdf); } catch {}
    try { execSync(`rm -rf "${tmpDir}"`); } catch {}
  }
}

const SECTION_PATTERNS = [
  /^SENTENÇA/i,
  /^ACÓRDÃO/i,
  /^ACORDAM/i,
  /Vistos,\s+relatados\s+e\s+discutidos/i,
  /JULGO\s+(PARCIALMENTE\s+)?PROCEDENTE/i,
  /JULGO\s+IMPROCEDENTE/i,
  /Ante o exposto/i,
  /ISTO POSTO/i,
  /Pelo exposto/i,
  /Diante do exposto/i,
  /Ex positis/i,
  /Em face do exposto/i,
  /Posto isso/i,
  /Por tais fundamentos/i,
  /^DISPOSITIVO/i,
  /Nego\s+provimento/i,
  /Negar\s+provimento/i,
  /Negam\s+provimento/i,
  /Dou\s+provimento/i,
  /Dar\s+provimento/i,
  /Deram\s+provimento/i,
  /\bcondeno\b/i,
];

const MAX_CHARS = 90000;

function extractRelevantSections(text) {
  if (text.length <= MAX_CHARS) return text;

  const lines = text.split("\n");
  const sections = [];
  let i = 0;

  while (i < lines.length) {
    const isKey = SECTION_PATTERNS.some((p) => p.test(lines[i]));
    if (isKey) {
      const start = Math.max(0, i - 5);
      const end = Math.min(lines.length, i + 120);
      sections.push(lines.slice(start, end).join("\n"));
      i = end;
    } else {
      i++;
    }
  }

  if (sections.length === 0 || sections.join("").length < 3000) {
    console.warn("Poucas seções encontradas — usando fallback início+fim");
    const inicio = text.slice(0, 40000);
    const fim = text.slice(-40000);
    return (inicio + "\n\n[...trecho central omitido...]\n\n" + fim).slice(0, MAX_CHARS);
  }

  let combined = sections.join("\n\n---\n\n");
  if (combined.length > MAX_CHARS) combined = combined.slice(-MAX_CHARS);
  return combined;
}

app.post("/analisar", upload.single("pdf"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ erro: "Nenhum arquivo PDF enviado." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ erro: "API key não configurada no servidor." });
  }

  let textoCompleto;
  try {
    textoCompleto = extractTextFromPdf(req.file.buffer);
  } catch (err) {
    console.error("Erro ao extrair texto do PDF:", err.message);
    return res.status(422).json({ erro: "Não foi possível extrair o texto do PDF. O arquivo pode estar corrompido ou protegido." });
  }

  if (!textoCompleto || textoCompleto.length < 100) {
    return res.status(422).json({ erro: "O PDF não contém texto legível mesmo após OCR. Verifique se o arquivo está legível." });
  }

  const textoRelevante = extractRelevantSections(textoCompleto);

  console.log(`[${req.file.originalname}] total: ${textoCompleto.length} chars | enviado: ${textoRelevante.length} chars | ~${Math.round(textoRelevante.length / 4)} tokens`);

  const systemPrompt = `Você é um assistente jurídico especializado em análise de processos cíveis brasileiros.
INSTRUÇÃO CRÍTICA: Sua resposta deve conter EXCLUSIVAMENTE um objeto JSON. Não escreva nenhuma palavra antes ou depois. Não use markdown. Não use blocos de código. Comece sua resposta diretamente com { e termine com }.
O JSON deve ter exatamente estas chaves:
{
  "reclamante": "Nome completo do reclamante/autor",
  "reclamada": "Nome completo da reclamada/réu",
  "houve_sentenca": "Sim" ou "Não",
  "houve_condenacao": "Sim" ou "Não",
  "descricao_condenacao": "Natureza da condenação (ex: danos morais, danos materiais, obrigação de fazer) ou Não aplicável",
  "valor_condenacao": "Apenas o valor monetário em reais (ex: R$ 12.500,00) ou Não aplicável",
  "houve_recurso": "Sim" ou "Não",
  "recurso_julgado": "Sim ou Não ou Não aplicável",
  "resultado_recurso": "Descrição do resultado ou Não aplicável",
  "valor_acordao": "Apenas o valor monetário em reais ou Não aplicável"
}
Se uma informação não estiver clara nos trechos, use o valor Não identificado.
LEMBRE-SE: responda SOMENTE com o JSON, começando com { e terminando com }.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: `Analise os seguintes trechos do processo cível e retorne o JSON:\n\n${textoRelevante}`,
        }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error("Erro da API Anthropic:", errBody);
      return res.status(502).json({ erro: "Erro ao consultar a IA. Tente novamente." });
    }

    const data = await response.json();
    const text = data.content.map((i) => i.text || "").join("");

    let resultado = null;
    try { resultado = JSON.parse(text.trim()); } catch {}
    if (!resultado) {
      try { resultado = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch {}
    }
    if (!resultado) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) { try { resultado = JSON.parse(match[0]); } catch {} }
    }
    if (!resultado) {
      console.error("Resposta inválida da IA:", text.slice(0, 300));
      return res.status(502).json({ erro: "A IA retornou um formato inesperado. Tente novamente." });
    }

    res.json(resultado);
  } catch (err) {
    console.error("Erro interno:", err);
    res.status(500).json({ erro: "Erro interno no servidor: " + err.message });
  }
});

app.use((err, req, res, next) => {
  res.status(400).json({ erro: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
