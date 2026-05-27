#!/usr/bin/env bash
set -e

echo "Instalando poppler-utils (pdftotext)..."
apt-get update -qq && apt-get install -y -qq poppler-utils

echo "Instalando dependências Node.js..."
npm install

echo "Build concluído."
