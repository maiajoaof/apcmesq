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
  limits: { fileSize: 32 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Apenas arquivos PDF são aceitos"));
  },
});

app.use(express.static(path.join(__dirname, "public")));

function extractTextFromPdf(buffer) {
  const tmpPdf = path.join(os.tmpdir(), `proc_${Date.now()}.pdf`);
  const tmpTxt = tmpPdf.replace(".pdf", ".txt");
  try {
    fs.writeFileSync(tmpPdf, buffer);
    execSync(`pdftotext "${tmpPdf}" "${tmpTxt}"`, { timeout: 30000 });
    return fs.readFileSync(tmpTxt, "utf8").trim();
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch {}
    try { fs.unlinkSync(tmpTxt); } catch {}
  }
}

function extractRelevantSections(text) {
  const lines = text.split("\n");

  const SECTION_KEYWORDS = [
    /^SENTENÇA/i,
    /^ACÓRDÃO/i,
    /^ACORDAM/i,
    /JULGO\s+(PARCIALMENTE\s+)?PROCEDENTE/i,
    /JULGO\s+IMPROCEDENTE/i,
    /Ante o exposto/i,
    /ISTO POSTO/i,
    /Pelo exposto/i,
    /Diante do exposto/i,
  ];

  const sections = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isKey = SECTION_KEYWORDS.some((rx) => rx.test(line));
    if (isKey) {
      const start = Math.max(0, i - 5);
      const end = Math.min(lines.length, i + 120);
      sections.push({ start, text: lines.slice(start, end).join("\n") });
      i = end - 1;
    }
  }

  if (sections.length === 0) {
    return text.slice(0, 60000);
  }

  const MAX = 80000;
  let combined = "";
  for (const sec of sections) {
    const block = `\n\n--- [trecho a partir da linha ${sec.start}] ---\n${sec.text}`;
    if ((combined + block).length > MAX) break;
    combined += block;
  }

  return combined.trim();
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
    return res.status(422).json({ erro: "Não foi possível extrair o texto do PDF. Verifique se o arquivo não é escaneado sem OCR." });
  }

  if (!textoCompleto || textoCompleto.length < 100) {
    return res.status(422).json({ erro: "O PDF não contém texto legível. Pode ser um arquivo escaneado sem OCR." });
  }

  const textoRelevante = extractRelevantSections(textoCompleto);

  console.log(`PDF: ${req.file.originalname} | total: ${textoCompleto.length} chars | enviado: ${textoRelevante.length} chars (~${Math.round(textoRelevante.length / 4)} tokens)`);

  const systemPrompt = `Você é um assistente jurídico especializado em análise de processos cíveis brasileiros.
Analise os trechos do processo fornecidos e retorne APENAS um JSON válido, sem markdown, sem texto antes ou depois.
O JSON deve ter exatamente estas chaves:
{
  "reclamante": "Nome completo do reclamante/autor",
  "reclamada": "Nome completo da reclamada/réu",
  "houve_sentenca": "Sim" ou "Não",
  "houve_condenacao": "Sim" ou "Não",
  "descricao_condenacao": "Natureza da condenação (ex: danos morais, danos materiais, obrigação de fazer) ou 'Não aplicável'",
  "valor_condenacao": "Apenas o valor monetário em reais (ex: R$ 12.500,00) ou 'Não aplicável'",
  "houve_recurso": "Sim" ou "Não",
  "recurso_julgado": "Sim", "Não" ou "Não aplicável",
  "resultado_recurso": "Descrição do resultado ou 'Não aplicável'",
  "valor_acordao": "Apenas o valor monetário em reais ou 'Não aplicável'"
}
Seja preciso. Se uma informação não estiver clara nos trechos, indique 'Não identificado'.`;

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
        messages: [
          {
            role: "user",
            content: `Analise os seguintes trechos do processo cível e retorne o JSON:\n\n${textoRelevante}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error("Erro da API Anthropic:", errBody);
      return res.status(502).json({ erro: "Erro ao consultar a IA. Tente novamente." });
    }

    const data = await response.json();
    const text = data.content.map((i) => i.text || "").join("");
    const clean = text.replace(/```json|```/g, "").trim();
    const resultado = JSON.parse(clean);

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
