#!/usr/bin/env python3
"""从剧本抽取设定：读项目全剧本 → GLM 抽取 角色/场景/道具 → 建实体(项目级)。
供"剧本页"一键使用；抽完可再跑 视觉词典(锁定细化) 与 AI拆镜头。
用法：python extract_setup.py <project_id> [--model glm-4.6]
"""
from __future__ import annotations
import argparse, json, re, time, urllib.error, urllib.request
from glm import chat_json
from http_util import get_all

SYS = """你是剧本设定抽取专家。通读完整剧本，抽取：
- 角色：所有有台词或明确动作的人物。
- 场景：独立地点（地点变化或同地点明显时间跳跃各算一个）。
- 物件（道具）判据——三选一才算，其余不列：①能被角色拿起/携带/递出/操作的可移动物品；②被台词点名或成为镜头/情节焦点的物品；③承载象征意义、推动情节的物品。
  【明确排除】车辆/房屋/门/窗/百叶窗/桌椅/沙发/地毯/方向盘/仪表/计价器/家具/建筑构件等固定或场景固有物，一律归入场景描述，绝不单列为道具。宁缺毋滥，只保留真正影响剧情的关键道具（通常一集 2-4 个）。
名称一律用剧本原文；描述写视觉化简述（后续会锁定细化，不必很长）。
【场景描述硬规则】
- 场景就是地点环境，不是剧情摘要。
- 只写地点类型、空间结构、方位布局、建筑/地面/墙面/门窗/树木/陈设/材质、光线、天气、年代痕迹。
- 不写任何人物、角色身份、动作、对白、剧情事件、回忆、幻影、情绪意义或叙事功能。
- 如果剧本只提供人物动作，请只保留动作发生的地点名称，并把描述写成空场景环境。
只输出 JSON。"""

USER_TMPL = """【完整剧本】
{script}

输出 JSON：
{{
  "characters": [{{"name":"", "appearance":"外貌简述(性别/年龄/发型/穿着大致)", "default_costume":"默认服装简述"}}],
  "scenes": [{{"name":"", "description":"只写空场景环境：空间结构/陈设/材质/光线/年代痕迹；不得含人物、动作、剧情、回忆"}}],
  "props": [{{"name":"", "description":"外观简述"}}]
}}"""

BASE = "http://localhost:8000/api/v1"


def clean_scene_text(value: str) -> str:
    # Do not try to maintain an endless blocklist here. Scene descriptions
    # are generated upstream as environment-only text; if empty, callers fall
    # back to the scene name.
    return (value or "").strip()


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
    return get_all(BASE, p)


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
        time.sleep(0.5)
    raise SystemExit(f"依赖未就绪 {path}")


def run(pid: str, model: str):
    proj = _req("GET", f"/studio/projects/{pid}")[1].get("data") or {}
    if not proj:
        raise SystemExit(f"项目 {pid} 不存在")
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

    # 重跑稳定性：先拉现有实体建 名称→id 映射，原名命中就复用旧 id；
    # 新 id 从现有最大序号之后接着分配，避免 GLM 枚举顺序变动导致 id 漂移/撞号。
    def alloc(etype, kw):
        existing = items(f"/studio/entities/{etype}?project_id={pid}&page_size=100")
        name2id = {e["name"]: e["id"] for e in existing}
        pat = re.compile(rf"^{re.escape(pid)}__{re.escape(kw)}_(\d+)$")
        mx = max((int(m.group(1)) for e in existing for m in [pat.match(e.get("id", ""))] if m), default=0)
        return name2id, mx

    def next_id(state, kw):
        state[1] += 1
        return pfx(f"{kw}_{state[1]:03d}")

    sc = data.get("scenes", []); pr = data.get("props", []); ch = data.get("characters", [])
    sc_n2i, sc_mx = alloc("scene", "scene"); sc_state = [sc_n2i, sc_mx]
    pr_n2i, pr_mx = alloc("prop", "prop"); pr_state = [pr_n2i, pr_mx]
    ch_n2i, ch_mx = alloc("character", "char"); ch_state = [ch_n2i, ch_mx]
    cos_n2i, cos_mx = alloc("costume", "cos"); cos_state = [cos_n2i, cos_mx]

    for s in sc:
        eid = sc_state[0].get(s["name"]) or next_id(sc_state, "scene")
        asset("scene", eid, s["name"], clean_scene_text(s.get("description", "")) or s["name"])
    for p in pr:
        eid = pr_state[0].get(p["name"]) or next_id(pr_state, "prop")
        asset("prop", eid, p["name"], p.get("description", ""))
    for c in ch:
        costume_id = None
        if c.get("default_costume"):
            cos_name = f"{c['name']}-默认服装"
            costume_id = cos_state[0].get(cos_name) or next_id(cos_state, "cos")
            asset("costume", costume_id, cos_name, c["default_costume"])
            wait_get(f"/studio/entities/costume/{costume_id}")
        char_id = ch_state[0].get(c["name"]) or next_id(ch_state, "char")
        body = {"id": char_id, "name": c["name"], "description": c.get("appearance", ""),
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
