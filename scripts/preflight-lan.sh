#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-check}"

read_env_key() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 1
  local value=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    case "$line" in
      "${key}"=*)
        value="${line#*=}"
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        ;;
    esac
  done < "$file"
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

get_config_value() {
  local key="$1"
  local value=""
  if value="$(read_env_key ".env.local" "$key" 2>/dev/null)"; then
    printf '%s\n' "$value"
    return 0
  fi
  if value="$(read_env_key ".env" "$key" 2>/dev/null)"; then
    printf '%s\n' "$value"
    return 0
  fi
  local fallback="${!key:-}"
  if [ -n "$fallback" ]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  return 1
}

list_contains_csv_value() {
  local csv="$1"
  local needle="$2"
  IFS=',' read -r -a parts <<< "$csv"
  for part in "${parts[@]}"; do
    local trimmed="${part#"${part%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    [ "$trimmed" = "$needle" ] && return 0
  done
  return 1
}

IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [ -z "${IP}" ]; then
  IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi
if [ -z "${IP}" ]; then
  echo "Não consegui detectar IP (en0/en1)."
  exit 1
fi

API_URL="http://${IP}:3000"
WEB_ORIGIN="http://${IP}:8081"

echo "IP=${IP}"
echo "API_URL=${API_URL}"
echo "WEB_ORIGIN=${WEB_ORIGIN}"

if lsof -iTCP:3000 -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  PORT_3000_STATUS="OK"
else
  PORT_3000_STATUS="FAIL"
fi
echo "PORT_3000=${PORT_3000_STATUS}"

if lsof -iTCP:8081 -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  PORT_8081_STATUS="OK"
else
  PORT_8081_STATUS="FAIL"
fi
echo "PORT_8081=${PORT_8081_STATUS}"

curl -i --max-time 5 "${API_URL}/api/auth/me" >/tmp/escalas_me.txt 2>&1 || true
head -n 8 /tmp/escalas_me.txt || true

CONFIG_API_URL="$(get_config_value EXPO_PUBLIC_API_URL || true)"
CONFIG_CORS_ALLOWED_ORIGINS="$(get_config_value CORS_ALLOWED_ORIGINS || true)"

if [ "${MODE}" = "check" ]; then
  if [ -n "${CONFIG_API_URL}" ] && [ "${CONFIG_API_URL}" != "${API_URL}" ]; then
    echo "WARNING: EXPO_PUBLIC_API_URL configurado (${CONFIG_API_URL}) difere do detectado (${API_URL})."
    echo "WARNING: Rode ./scripts/preflight-lan.sh apply"
    echo "WARNING: Reinicie Expo com cache limpo: pnpm expo start -c --web --port 8081"
  fi

  if [ -n "${CONFIG_CORS_ALLOWED_ORIGINS}" ] && ! list_contains_csv_value "${CONFIG_CORS_ALLOWED_ORIGINS}" "${WEB_ORIGIN}"; then
    echo "WARNING: CORS_ALLOWED_ORIGINS não contém ${WEB_ORIGIN}."
    echo "WARNING: Rode ./scripts/preflight-lan.sh apply"
    echo "WARNING: Reinicie Expo com cache limpo: pnpm expo start -c --web --port 8081"
  fi

  if [ "${PORT_3000_STATUS}" = "FAIL" ]; then
    echo "WARNING: Backend não está ouvindo na porta 3000."
    echo "WARNING: Suba o backend: pnpm dev:server"
  fi

  if [ "${PORT_8081_STATUS}" = "FAIL" ]; then
    echo "WARNING: Expo Web não está ouvindo na porta 8081."
    echo "WARNING: Reinicie Expo com cache limpo: pnpm expo start -c --web --port 8081"
  fi
fi

if [ "${MODE}" = "apply" ]; then
  python3 - <<PY
from pathlib import Path

ip = "${IP}"
api_url = f"http://{ip}:3000"
web_origin = f"http://{ip}:8081"

def upsert_env(path: Path, key: str, value: str):
    if not path.exists():
        path.write_text(f"{key}={value}\n", encoding="utf-8")
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    out = []
    found = False
    for line in lines:
        if line.startswith(f"{key}="):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}={value}")
    path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")

def add_origin_to_cors(path: Path, origin: str):
    if not path.exists():
        path.write_text(f"CORS_ALLOWED_ORIGINS={origin}\n", encoding="utf-8")
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    out = []
    done = False
    for line in lines:
        if line.startswith("CORS_ALLOWED_ORIGINS="):
            val = line.split("=",1)[1].strip()
            parts = [p.strip() for p in val.split(",") if p.strip()]
            if origin not in parts:
                parts.append(origin)
            out.append("CORS_ALLOWED_ORIGINS=" + ",".join(parts))
            done = True
        else:
            out.append(line)
    if not done:
        out.append(f"CORS_ALLOWED_ORIGINS={origin}")
    path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")

root = Path(".")
for env_name in [".env", ".env.local"]:
    p = root / env_name
    upsert_env(p, "EXPO_PUBLIC_API_URL", api_url)
    add_origin_to_cors(p, web_origin)

print("UPDATED_ENVS=.env,.env.local")
print("EXPO_PUBLIC_API_URL=" + api_url)
print("CORS_ADD_ORIGIN=" + web_origin)
PY

  FINAL_API_URL="$(get_config_value EXPO_PUBLIC_API_URL || true)"
  FINAL_CORS_ALLOWED_ORIGINS="$(get_config_value CORS_ALLOWED_ORIGINS || true)"
  echo "OK: EXPO_PUBLIC_API_URL final=${FINAL_API_URL:-<missing>}"
  if [ -n "${FINAL_CORS_ALLOWED_ORIGINS}" ] && list_contains_csv_value "${FINAL_CORS_ALLOWED_ORIGINS}" "${WEB_ORIGIN}"; then
    echo "OK: CORS_ALLOWED_ORIGINS contém ${WEB_ORIGIN}"
  else
    echo "OK: CORS_ALLOWED_ORIGINS não contém ${WEB_ORIGIN}"
  fi
fi

echo "DONE"
