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

const SECTION_PATTERNS = [
  // Cabeçalhos de peças
  /^SENTENÇA/i,
  /^ACÓRDÃO/i,
  /^ACORDAM/i,
  /Vistos,\s+relatados\s+e\s+discutidos/i,
  // Dispositivos de sentença
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
  // Dispositivos de acórdão
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
  // Documentos pequenos: envia tudo
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

  // Fallback: sem keywords encontradas — usa início + fim
  if (sections.length === 0 || sections.join("").length < 3000) {
    console.warn("Poucos resultados com keywords — usando fallback início+fim");
    const inicio = text.slice(0, 40000);
    const fim = text.slice(-40000);
    return (inicio + "\n\n[...trecho central omitido...]\n\n" + fim).slice(0, MAX_CHARS);
  }

  let combined = sections.join("\n\n---\n\n");

  // Se ainda passou do limite, mantém as últimas seções (mais relevantes)
  if (combined.length > MAX_CHARS) {
    combined = combined.slice(-MAX_CHARS);
  }

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
    return res.status(422).json({ erro: "Não foi possível extrair o texto do PDF. Verifique se o arquivo não é escaneado sem OCR." });
  }

  if (!textoCompleto || textoCompleto.length < 100) {
    return res.status(422).json({ erro: "O PDF não contém texto legível. Pode ser um arquivo escaneado sem OCR." });
  }

  const textoRelevante = extractRelevantSections(textoCompleto);

  console.log(
    `[${req.file.originalname}] total: ${textoCompleto.length} chars | ` +
    `enviado: ${textoRelevante.length} chars | ` +
    `~${Math.round(textoRelevante.length / 4)} tokens`
  );

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

    let resultado = null;
    // Tentativa 1: JSON direto
    try { resultado = JSON.parse(text.trim()); } catch {}
    // Tentativa 2: remove markdown e tenta novamente
    if (!resultado) {
      try { resultado = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch {}
    }
    // Tentativa 3: extrai o primeiro bloco { ... } do texto
    if (!resultado) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) { try { resultado = JSON.parse(match[0]); } catch {} }
    }
    if (!resultado) {
      console.error("Resposta da IA não era JSON válido:", text.slice(0, 300));
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
