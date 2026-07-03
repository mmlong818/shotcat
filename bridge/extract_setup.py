#!/usr/bin/env python3
"""从剧本抽取设定：读项目全剧本 → GLM 抽取 角色/场景/道具 → 建实体(项目级)。
供"剧本页"一键使用；抽完可再跑 视觉词典(锁定细化) 与 AI拆镜头。
用法：python extract_setup.py <project_id> [--model glm-4.6]
"""
from __future__ import annotations
import argparse, json, urllib.error, urllib.request
from glm import chat_json

SYS = """你是剧本设定抽取专家。通读完整剧本，抽取：
- 角色：所有有台词或明确动作的人物。
- 场景：独立地点（地点变化或同地点明显时间跳跃各算一个）。
- 物件：有叙事功能（被拿起/指向/谈论/象征/推动情节）的道具，纯装饰不算。
名称一律用剧本原文；描述写视觉化简述（后续会锁定细化，不必很长）。
只输出 JSON。"""

USER_TMPL = """【完整剧本】
{script}

输出 JSON：
{{
  "characters": [{{"name":"", "appearance":"外貌简述(性别/年龄/发型/穿着大致)", "default_costume":"默认服装简述"}}],
  "scenes": [{{"name":"", "description":"空间/氛围简述"}}],
  "props": [{{"name":"", "description":"外观简述"}}]
}}"""

BASE = "http://localhost:8000/api/v1"


def _req(m, p, b=None, t=40):
    data = json.dumps(b).encode() if b is not None else None
    r = urllib.request.Request(BASE + p, data=data, headers={"Content-Type": "application/json"} if data else {}, method=m)
    try:
        with urllib.request.urlopen(r, timeout=t) as x:
            return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


def items(p):
    return (_req("GET", p)[1].get("data") or {}).get("items", [])


def create_idem(path, body):
    c, r = _req("POST", path, body)
    if c < 400:
        return "created"
    msg = str(r.get("message", ""))
    if "already exists" in msg or "已存在" in msg:
        return "exists"
    print(f"    ! {path} {c} {msg[:60]}")
    return "fail"


def wait_get(path, tries=30):
    for _ in range(tries):
        if _req("GET", path)[0] == 200:
            return
    raise SystemExit(f"依赖未就绪 {path}")


def run(pid: str, model: str):
    proj = _req("GET", f"/studio/projects/{pid}")[1].get("data", {})
    style = proj.get("style") or "真人都市"
    visual = proj.get("visual_style") or "现实"
    chapters = sorted(items(f"/studio/chapters?project_id={pid}&page_size=100"), key=lambda c: c.get("index", 0))
    script = "\n\n".join(c.get("raw_text", "") for c in chapters)
    if not script.strip():
        raise SystemExit("项目无剧本正文，请先在剧本页粘贴剧本")

    print(f"[抽取设定] 项目 {pid}｜剧本 {len(script)} 字｜模型 {model}")
    data = chat_json(SYS, USER_TMPL.format(script=script), model=model, temperature=0.5, timeout=420)

    def pfx(raw):
        return f"{pid}__{raw}"

    def asset(etype, eid, name, desc):
        return create_idem(f"/studio/entities/{etype}", {
            "id": eid, "name": name, "description": desc,
            "style": style, "visual_style": visual, "project_id": pid,
        })

    sc = data.get("scenes", []); pr = data.get("props", []); ch = data.get("characters", [])
    for i, s in enumerate(sc, 1):
        asset("scene", pfx(f"scene_{i:03d}"), s["name"], s.get("description", ""))
    for i, p in enumerate(pr, 1):
        asset("prop", pfx(f"prop_{i:03d}"), p["name"], p.get("description", ""))
    for i, c in enumerate(ch, 1):
        costume_id = None
        if c.get("default_costume"):
            costume_id = pfx(f"cos_{i:03d}")
            asset("costume", costume_id, f"{c['name']}-默认服装", c["default_costume"])
            wait_get(f"/studio/entities/costume/{costume_id}")
        body = {"id": pfx(f"char_{i:03d}"), "name": c["name"], "description": c.get("appearance", ""),
                "style": style, "visual_style": visual, "project_id": pid}
        if costume_id:
            body["costume_id"] = costume_id
        create_idem("/studio/entities/character", body)

    print(f"=== 抽取完成：角色 {len(ch)}｜场景 {len(sc)}｜道具 {len(pr)} ===")
    print("下一步：造型页「① 锁定视觉词典」细化 → 「② 生成缺失造型图」；分镜页「AI 拆镜头」")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pid")
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--model", default="glm-4.6")
    a = ap.parse_args()
    globals()["BASE"] = a.base.rstrip("/") + "/api/v1"
    run(a.pid, a.model)
