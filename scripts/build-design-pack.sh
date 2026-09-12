#!/usr/bin/env bash
# scripts/build-design-pack.sh — monta o zip que vai para o Claude Design.
#
# ## Por que existe
#
# O pacote de 23/08 foi montado à mão e envelheceu sem que ninguém soubesse o
# quanto: o designer propunha o que já estava mergeado, e ninguém percebia até
# a proposta chegar. Aqui o nome do arquivo carrega o SHA e a data, e o pacote
# gera a própria capa — "o pacote que eu tenho" deixa de ser adivinhação dos
# dois lados.
#
# ## O que vai dentro
#
# Só o que decide aparência: tokens, a especificação escrita, os componentes,
# as telas e a arte. Servidor, testes e migrações ficam de fora de propósito —
# o designer não precisa deles e o pacote não deve virar um dump do repo.
#
# ## Uso
#
#   ./scripts/build-design-pack.sh [diretório de saída]
#
# Saída: <dir>/escala-design-pack-<data>-<sha>.zip
#
# A capa `PACOTE.md` é gerada sempre, com baseline, inventário e os commits
# recentes que mexeram em aparência. Se existir `docs/design/LEIA-PRIMEIRO.md`
# — a carta escrita à mão para um handoff específico — ela entra junto.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

out_dir="${1:-$repo_root/docs/design/packs}"
sha="$(git rev-parse --short HEAD)"
stamp="$(date +%Y-%m-%d)"
pack_name="escala-design-pack-${stamp}-${sha}"
tmp_root="$(mktemp -d)"
stage="$tmp_root/$pack_name"

trap 'rm -rf "$tmp_root"' EXIT

mkdir -p "$stage"

# Tokens e regras visuais que viram código.
mkdir -p "$stage/lib"
for f in theme.ts shift-status.ts shift-visual.ts weather-greeting.ts \
         weather-scene.ts agenda-overflow.ts agenda-mobile-day.ts; do
  [ -f "lib/$f" ] && cp "lib/$f" "$stage/lib/$f"
done

# A especificação escrita.
mkdir -p "$stage/docs/design"
for f in ui-system.md icon-system.md ui-audit.md; do
  [ -f "docs/design/$f" ] && cp "docs/design/$f" "$stage/docs/design/$f"
done

# Componentes: o sistema e os conjuntos de tela.
for dir in ui agenda home brand swaps shifts; do
  if [ -d "components/$dir" ]; then
    mkdir -p "$stage/components/$dir"
    find "components/$dir" -maxdepth 1 -name '*.tsx' -exec cp {} "$stage/components/$dir/" \;
  fi
done

# Telas.
mkdir -p "$stage/app" "$stage/app/(tabs)"
find app -maxdepth 1 -name '*.tsx' -exec cp {} "$stage/app/" \;
[ -d "app/(tabs)" ] && find "app/(tabs)" -maxdepth 1 -name '*.tsx' -exec cp {} "$stage/app/(tabs)/" \;

# Arte de clima: as cenas em 1x (as @2x/@3x só mudam de densidade) e a fonte
# vetorial, que é por onde se mexe na arte — não pelos PNGs.
if [ -d assets/weather ]; then
  mkdir -p "$stage/assets/weather"
  find assets/weather -maxdepth 1 -name '*.png' ! -name '*@2x.png' ! -name '*@3x.png' \
    -exec cp {} "$stage/assets/weather/" \;
  [ -d assets/weather/source ] && cp -R assets/weather/source "$stage/assets/weather/source"
fi
if [ -d scripts/weather ]; then
  mkdir -p "$stage/scripts/weather"
  find scripts/weather -maxdepth 1 -type f -exec cp {} "$stage/scripts/weather/" \;
fi

# A carta escrita à mão para este handoff, quando existir, e este próprio
# script — o pacote se explica e se refaz sem depender de quem o montou.
[ -f "docs/design/LEIA-PRIMEIRO.md" ] && cp "docs/design/LEIA-PRIMEIRO.md" "$stage/"
cp "${BASH_SOURCE[0]}" "$stage/build-design-pack.sh"

count() { find "$stage/$1" -type f 2>/dev/null | wc -l | tr -d ' '; }

# Commits recentes que mexeram em aparência. É o que responde, sem ninguém
# escrever à mão, a pergunta que todo handoff começa fazendo: "o que mudou
# desde o meu último pacote?".
design_log="$(git log --oneline -20 --no-merges -- \
  lib/theme.ts components/ui components/agenda app docs/design assets/weather \
  2>/dev/null || true)"

cat > "$stage/PACOTE.md" <<COVER
# Pacote de design — Escala+

| | |
|---|---|
| Baseline | \`$sha\` |
| Gerado em | $stamp |
| Gerador | \`scripts/build-design-pack.sh\` (vai junto, na raiz) |

Tudo aqui é o código que está no repositório nesse commit. Não é proposta.

## Inventário

| Pasta | Arquivos | O que é |
|---|---|---|
| \`lib/\` | $(count lib) | tokens, status de plantão, traje visual, regras de clima |
| \`docs/design/\` | $(count docs/design) | a especificação escrita |
| \`components/ui/\` | $(count components/ui) | o sistema de componentes |
| \`components/agenda/\` | $(count components/agenda) | folha de calendário, grade panorâmica, lista do dia |
| \`components/\` (demais) | $(( $(count components) - $(count components/ui) - $(count components/agenda) )) | saudação, marca, trocas, plantões |
| \`app/\` | $(count app) | telas, incluindo as abas em \`app/(tabs)/\` |
| \`assets/weather/\` | $(count assets/weather) | as cenas de céu em 1x + a fonte vetorial |

## O que NÃO vai dentro, de propósito

Servidor, banco, testes e migrações. O pacote decide aparência; quem precisa
do resto abre o repositório.

## Últimas mudanças de aparência

\`\`\`
$design_log
\`\`\`

## Como refazer

\`\`\`bash
./scripts/build-design-pack.sh
\`\`\`

O nome do arquivo carrega SHA e data: se dois lados discordarem sobre "o
pacote atual", é o nome que resolve.
COVER

mkdir -p "$out_dir"
( cd "$tmp_root" && zip -qr "$out_dir/${pack_name}.zip" "$pack_name" )

echo "$out_dir/${pack_name}.zip  ($(find "$stage" -type f | wc -l | tr -d ' ') arquivos, baseline $sha)"
