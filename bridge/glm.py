"""GLM 客户端（OpenAI 兼容，标准库）。key 取 env GLM_API_KEY 或同目录 .glm_key。"""
from __future__ import annotations
import json, os, re, urllib.request
from pathlib import Path

BASE = "https://open.bigmodel.cn/api/paas/v4"


def _key() -> str:
    k = os.environ.get("GLM_API_KEY")
    if k:
        return k.strip()
    f = Path(__file__).with_name(".glm_key")
    if f.exists():
        return f.read_text(encoding="utf-8").strip()
    raise SystemExit("缺少 GLM key：设 GLM_API_KEY 或写 bridge/.glm_key")


def _extract_json(text: str):
    t = text.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", t)
    if m:
        t = m.group(1).strip()
    s, e = t.find("{"), t.rfind("}")
    if s != -1 and e > s:
        t = t[s:e + 1]
    return json.loads(t)


def chat_json(system: str, user: str, *, model: str = "glm-4.6", temperature: float = 0.7, timeout: int = 240):
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system + "\n\n只输出合法 JSON，不要解释或 markdown。"},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {_key()}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read())
    return _extract_json(resp["choices"][0]["message"]["content"])
