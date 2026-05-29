require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");
const { execSync, spawn } = require("child_process");
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

// SSE: mapa de clientes aguardando progresso
const sseClients = new Map();

app.get("/progresso/:jobId", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.set(req.params.jobId, res);
  req.on("close", () => sseClients.delete(req.params.jobId));
});

function sendProgress(jobId, step, pct, msg) {
  const client = sseClients.get(jobId);
  if (client) client.write(`data: ${JSON.stringify({ step, pct, msg })}\n\n`);
}

function getPageCount(pdfPath) {
  try {
    const out = execSync(`pdfinfo "${pdfPath}"`, { timeout: 15000 }).toString();
    const match = out.match(/Pages:\s*(\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch { return 0; }
}

// Roda pdftotext de forma assíncrona — não bloqueia o event loop
function runPdfToText(pdfPath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn("pdftotext", [pdfPath, "-"], {
      timeout: 300000, // 5 minutos — generoso para qualquer arquivo
    });

    proc.stdout.on("data", (chunk) => chunks.push(chunk));
    proc.stderr.on("data", (d) => console.warn("pdftotext stderr:", d.toString().trim()));

    proc.on("close", (code) => {
      if (code !== 0 && chunks.length === 0) {
        return reject(new Error(`pdftotext saiu com código ${code}`));
      }
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });

    proc.on("error", reject);
  });
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
    console.warn("Poucas seções — usando fallback início+fim");
    const inicio = text.slice(0, 40000);
    const fim = text.slice(-40000);
    return (inicio + "\n\n[...trecho central omitido...]\n\n" + fim).slice(0, MAX_CHARS);
  }

  let combined = sections.join("\n\n---\n\n");
  if (combined.length > MAX_CHARS) combined = combined.slice(-MAX_CHARS);
  return combined;
}

app.post("/analisar", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "Nenhum arquivo PDF enviado." });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "API key não configurada no servidor." });

  const jobId = req.headers["x-job-id"] || Date.now().toString();
  const id = Date.now();
  const tmpPdf = path.join(os.tmpdir(), `proc_${id}.pdf`);

  try {
    sendProgress(jobId, 1, 10, "Lendo o arquivo PDF...");
    fs.writeFileSync(tmpPdf, req.file.buffer);

    const totalPages = getPageCount(tmpPdf);
    const pageInfo = totalPages > 0 ? `${totalPages} páginas` : "páginas desconhecidas";

    sendProgress(jobId, 2, 25, `Extraindo texto (${pageInfo})...`);
    let textoCompleto;
    try {
      textoCompleto = await runPdfToText(tmpPdf);
    } catch (err) {
      console.error("Erro no pdftotext:", err.message);
      return res.status(422).json({ erro: "Não foi possível extrair o texto do PDF. O arquivo pode estar corrompido ou protegido." });
    }

    if (!textoCompleto || textoCompleto.length < 100) {
      return res.status(422).json({ erro: "O PDF não contém texto legível. Pode ser 100% escaneado sem OCR." });
    }

    console.log(`[${req.file.originalname}] ${pageInfo} | ${textoCompleto.length} chars extraídos`);

    sendProgress(jobId, 3, 55, "Identificando seções relevantes...");
    const textoRelevante = extractRelevantSections(textoCompleto);

    console.log(`Enviando: ${textoRelevante.length} chars | ~${Math.round(textoRelevante.length / 4)} tokens`);

    sendProgress(jobId, 4, 70, "Consultando a IA...");

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
  "valor_acordao": "Apenas o valor monetário em reais ou Não aplicável",
  "advogado_reclamada_nome": "Nome completo do advogado que representa a reclamada/réu, incluindo número OAB se disponível. Procure por expressões como 'Dr.', 'Dra.', 'Adv.', 'OAB', 'patrono', 'subscreve', 'representado por' associadas à parte ré",
  "advogado_reclamada_telefone": "Telefone de contato do advogado da reclamada, incluindo DDD (ex: (11) 99999-9999). Procure em rodapés, cabeçalhos e qualificações das partes"
}
Se uma informação não estiver clara nos trechos, use o valor Não identificado.
LEMBRE-SE: responda SOMENTE com o JSON, começando com { e terminando com }.`;

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
      sendProgress(jobId, 0, 0, "Erro na IA");
      return res.status(502).json({ erro: "Erro ao consultar a IA. Tente novamente." });
    }

    sendProgress(jobId, 5, 90, "Processando resultado...");

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
      console.error("Resposta inválida:", text.slice(0, 300));
      sendProgress(jobId, 0, 0, "Formato inválido");
      return res.status(502).json({ erro: "A IA retornou um formato inesperado. Tente novamente." });
    }

    sendProgress(jobId, 6, 100, "Concluído!");
    res.json(resultado);

  } catch (err) {
    console.error("Erro interno:", err);
    sendProgress(jobId, 0, 0, "Erro interno");
    res.status(500).json({ erro: "Erro interno no servidor: " + err.message });
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch {}
  }
});

app.use((err, req, res, next) => {
  res.status(400).json({ erro: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
