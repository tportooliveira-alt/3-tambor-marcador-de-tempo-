#!/bin/sh
# Gera FotocelulaTambor.xcodeproj a partir de project.yml (XcodeGen) — use se o .xcodeproj
# commitado não abrir na sua versão do Xcode.
set -e
cd "$(dirname "$0")"
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "Instalando XcodeGen via Homebrew..."
  brew install xcodegen
fi
xcodegen generate
echo "Pronto: abra FotocelulaTambor.xcodeproj"
