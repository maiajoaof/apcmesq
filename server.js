require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");

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

app.post("/analisar", upload.single("pdf"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ erro: "Nenhum arquivo PDF enviado." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ erro: "API key não configurada no servidor." });
  }

  const base64 = req.file.buffer.toString("base64");

  const systemPrompt = `Você é um assistente jurídico especializado em análise de processos cíveis brasileiros.
Analise o documento e retorne APENAS um JSON válido, sem markdown, sem texto antes ou depois.
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
Seja preciso. Se uma informação não estiver clara no documento, indique 'Não identificado'.`;

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
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: base64,
                },
              },
              {
                type: "text",
                text: "Analise este processo cível e retorne o JSON conforme instruído.",
              },
            ],
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
