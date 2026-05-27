# Analisador de Processos Cíveis

## Rodando localmente

### Pré-requisitos
- [Node.js](https://nodejs.org) instalado (versão 18 ou superior)

### Passo a passo

**1. Instale as dependências**
```bash
npm install
```

**2. Configure sua API Key**

Copie o arquivo de exemplo e edite com sua chave:
```bash
cp .env.example .env
```

Abra o arquivo `.env` e substitua pelo valor real:
```
ANTHROPIC_API_KEY=sk-ant-api03-sua-chave-aqui
```

**3. Inicie o servidor**
```bash
npm start
```

**4. Acesse no navegador**
```
http://localhost:3000
```

---

## Deploy (produção)

Consulte o arquivo `DEPLOY.md` para o guia completo de publicação no Render.com.
