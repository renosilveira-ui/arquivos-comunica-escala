#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-check}"

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

lsof -iTCP:3000 -sTCP:LISTEN -n -P >/dev/null 2>&1 && echo "PORT_3000=OK" || echo "PORT_3000=FAIL"
lsof -iTCP:8081 -sTCP:LISTEN -n -P >/dev/null 2>&1 && echo "PORT_8081=OK" || echo "PORT_8081=FAIL"

curl -i --max-time 5 "${API_URL}/api/auth/me" >/tmp/escalas_me.txt 2>&1 || true
head -n 8 /tmp/escalas_me.txt || true

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
fi

echo "DONE"
