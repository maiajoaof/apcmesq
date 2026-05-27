# 🚀 Guia de Deploy — Analisador de Processos Cíveis

Siga este guia do zero até a aplicação no ar. Tempo estimado: **15–20 minutos**.

---

## O que você vai precisar

- Uma conta no **GitHub** (gratuita) → https://github.com
- Uma conta no **Render.com** (gratuito) → https://render.com
- Sua **API Key da Anthropic** (do Console)

---

## Passo 1 — Criar repositório no GitHub

1. Acesse https://github.com e faça login
2. Clique no botão **"New"** (canto superior esquerdo, ícone de +)
3. Em **"Repository name"**, digite: `analisador-processo-civil`
4. Deixe como **Public** (necessário para o plano gratuito do Render)
5. Clique em **"Create repository"**

---

## Passo 2 — Fazer upload dos arquivos

Na página do repositório recém-criado, clique em **"uploading an existing file"**.

Faça upload de **todos** os arquivos desta pasta:
- `server.js`
- `package.json`
- `.gitignore`
- A pasta `public/` com o arquivo `index.html` dentro

> 💡 **Dica**: arraste a pasta inteira `processo-civil` para a área de upload do GitHub.

Clique em **"Commit changes"**.

---

## Passo 3 — Criar o serviço no Render

1. Acesse https://render.com e crie uma conta (pode usar a conta do GitHub para entrar)
2. No dashboard, clique em **"New +"** → **"Web Service"**
3. Clique em **"Connect a repository"**
4. Autorize o Render a acessar seu GitHub e selecione o repositório `analisador-processo-civil`
5. Preencha as configurações:

| Campo | Valor |
|-------|-------|
| **Name** | analisador-processo-civil |
| **Region** | Oregon (US West) ou qualquer um |
| **Branch** | main |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | Free |

6. Clique em **"Create Web Service"**

---

## Passo 4 — Adicionar a API Key (variável de ambiente)

⚠️ Este é o passo mais importante para a segurança. A API key fica no servidor, nunca exposta no frontend.

1. No painel do seu serviço no Render, clique em **"Environment"** (menu lateral)
2. Clique em **"Add Environment Variable"**
3. Preencha:
   - **Key**: `ANTHROPIC_API_KEY`
   - **Value**: sua chave da Anthropic (começa com `sk-ant-...`)
4. Clique em **"Save Changes"**

O Render vai reiniciar o servidor automaticamente.

---

## Passo 5 — Acessar a aplicação

Após o deploy (1–2 minutos), o Render vai mostrar uma URL no topo da página, no formato:

```
https://analisador-processo-civil.onrender.com
```

Clique nela — sua aplicação está no ar! 🎉

Compartilhe esse link com quem precisar.

---

## ⚠️ Observações importantes

**Plano gratuito do Render:**
O serviço gratuito "dorme" após 15 minutos sem uso. O primeiro acesso após o período de inatividade pode demorar 30–60 segundos para "acordar". Para uso contínuo, considere o plano pago ($7/mês).

**Custo da API Anthropic:**
Cada análise de PDF consome tokens. O custo médio por análise é de aproximadamente **$0,01 a $0,05** dependendo do tamanho do processo. Monitore seu uso no Console da Anthropic.

**PDFs escaneados:**
Se o PDF for uma imagem escaneada sem texto selecionável (OCR), a qualidade da análise pode ser menor. Prefira PDFs com texto nativo.

---

## Estrutura dos arquivos

```
processo-civil/
├── server.js          ← Backend Node.js (nunca expõe a API key)
├── package.json       ← Dependências do projeto
├── .gitignore         ← Ignora node_modules e .env
└── public/
    └── index.html     ← Frontend (interface visual)
```

---

## Problemas comuns

**"Application error" no Render:**
- Verifique se a variável `ANTHROPIC_API_KEY` foi adicionada corretamente
- Veja os logs em "Logs" no painel do Render

**PDF não é analisado:**
- Verifique se o arquivo tem menos de 32 MB
- Verifique se é um PDF com texto (não escaneado)
- Cheque o saldo de créditos no Console da Anthropic

**Site não abre:**
- O serviço pode estar "dormindo" (plano gratuito). Aguarde 60 segundos e tente novamente.
