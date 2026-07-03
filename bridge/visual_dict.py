#!/usr/bin/env python3
"""第一阶段·视觉词典：读项目全剧本 → GLM 生成锁定描述 → 回填造型库(角色/场景/道具/服装)。
方法依据 knowledge/prompts/微短剧生成提示词.md 第一阶段。
用法：python visual_dict.py <project_id> [--base http://localhost:8000] [--model glm-4.6]
"""
from __future__ import annotations
import argparse, json, urllib.error, urllib.request
from pathlib import Path
from glm import chat_json

SYS = """你是微短剧AI视频制作的"视觉词典"专家。通读完整剧本，为给定的角色/场景/物件产出【可直接复制粘贴、供每次AIGC生成复用】的锁定描述。

要求（对每一项都写成连贯的一段话，视觉化、可被画出，禁用抽象词）：
- 角色 appearance_lock：性别年龄段、身高体态姿态、发型发色、至少5个面部细节(眉/眼/鼻/唇/颧骨/下颌/肤质/皱纹疤痕痣等)、整体轮廓。精度需让没见过的人能画出八成相似。
- 角色 performance：情绪底色 + 情绪弧线(起点→转折→终点) + 1-2个标志动作 + 声音特征。
- 角色 costume：默认服装完整描述(上装/内搭/下装/鞋/配饰)，一段话，**必须点明服装所属年代/款式年代**(如"九十年代末蓝白运动校服")。
- 场景 space_lock：类型(室内外)、空间性质推断、尺度感、布局陈设(用画面方位)、墙面地面材质颜色损耗、材质关键词、氛围关键词，**并带入年代线索**(陈设/建材/物品的年代特征)。
- 场景 lighting：按剧中时段(日/黄昏/夜等)分别写主光源方向色温、明暗分布、色彩基调。
- 物件 appearance_lock：尺寸、形状、颜色、材质、损耗、表面细节(刻痕/锈渍/文字)，**若是有年代感的物件要写明年代款式**。
- 物件 function：一句话叙事功能。
- era_note：**全剧年代感/时代背景**——推断故事所处年代与时代标志物；若存在不同时代/新旧对比(回忆 vs 现在、二十年前 vs 当下)，分别写明各自的年代视觉特征与对比关系。
- style_statement：一句可复制到每个镜头开头的风格声明(影调/对比/暗部亮部色偏/质感)，**并体现年代质感**(如怀旧胶片/年代褪色感，如适用)。

年代感是重点：从剧本线索(服装、物品、场景、台词提到的时间)推断并显式写出年代特征，不要写成无年代的通用画面。
剧本明确写的如实提取；视觉必要但未写的可合理补充。名称必须与给定实体名完全一致，用作 JSON 键。"""

USER_TMPL = """【完整剧本】
{script}

【本项目实体（名称必须原样用作键）】
角色：{chars}
场景：{scenes}
物件：{props}

输出 JSON：
{{
  "style_statement": "…",
  "era_note": "全剧年代背景与时代感，含新旧/回忆对比(如适用)",
  "characters": [{{"name":"", "appearance_lock":"", "performance":"", "costume":""}}],
  "scenes": [{{"name":"", "space_lock":"", "lighting":""}}],
  "props": [{{"name":"", "appearance_lock":"", "function":""}}]
}}"""

BASE = "http://localhost:8000/api/v1"


def _req(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data,
                               headers={"Content-Type": "application/json"} if data else {}, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


def get_items(path):
    _, j = _req("GET", path)
    return (j.get("data") or {}).get("items", [])


def patch_desc(entity_type, eid, description):
    c, _ = _req("PATCH", f"/studio/entities/{entity_type}/{eid}", {"description": description})
    return c < 400


def run(pid: str, model: str):
    chapters = get_items(f"/studio/chapters?project_id={pid}&page_size=100")
    script = "\n\n".join(c.get("raw_text", "") for c in sorted(chapters, key=lambda x: x.get("index", 0)))
    if not script.strip():
        raise SystemExit("项目无剧本正文（chapters.raw_text 为空）")
    chars = get_items(f"/studio/entities/character?project_id={pid}&page_size=100")
    scenes = get_items(f"/studio/entities/scene?project_id={pid}&page_size=100")
    props = get_items(f"/studio/entities/prop?project_id={pid}&page_size=100")

    print(f"[视觉词典] 项目 {pid}｜剧本 {len(script)} 字｜角色 {len(chars)} 场景 {len(scenes)} 物件 {len(props)}｜模型 {model}")
    print("  调 GLM 生成锁定描述…（长上下文，约 30-90s）")
    user = USER_TMPL.format(
        script=script,
        chars="、".join(c["name"] for c in chars),
        scenes="、".join(s["name"] for s in scenes),
        props="、".join(p["name"] for p in props),
    )
    vd = chat_json(SYS, user, model=model, temperature=0.7, timeout=420)

    Path(__file__).with_name(f"visual-dict-{pid}.json").write_text(
        json.dumps(vd, ensure_ascii=False, indent=2), encoding="utf-8")

    by = lambda arr: {x.get("name"): x for x in arr}
    vc, vs, vp = by(vd.get("characters", [])), by(vd.get("scenes", [])), by(vd.get("props", []))

    print("  回填造型库：")
    for c in chars:
        d = vc.get(c["name"])
        if not d:
            continue
        # 造型图依据：description 只放【外貌锁定】(纯视觉)；表演基线(性格/情绪/声音)留在词典 JSON 供视听单元/视频用，不进生图 prompt
        desc = d.get("appearance_lock", "")
        patch_desc("character", c["id"], desc)
        print(f"    [角色] {c['name']} ← 外貌锁定({len(desc)}字，表演基线不入生图)")
        # 该角色默认服装
        cid = c.get("costume_id")
        if cid and d.get("costume"):
            patch_desc("costume", cid, d["costume"])
            print(f"      服装 {cid} ← 服装档案")
    for s in scenes:
        d = vs.get(s["name"])
        if not d:
            continue
        desc = d.get("space_lock", "")
        if d.get("lighting"):
            desc += "\n\n【光照】" + d["lighting"]
        patch_desc("scene", s["id"], desc)
        print(f"    [场景] {s['name']} ← 空间+光照锁定({len(desc)}字)")
    for p in props:
        d = vp.get(p["name"])
        if not d:
            continue
        desc = d.get("appearance_lock", "")
        if d.get("function"):
            desc += "\n\n【叙事功能】" + d["function"]
        patch_desc("prop", p["id"], desc)
        print(f"    [物件] {p['name']} ← 外观锁定({len(desc)}字)")

    print(f"\n=== 完成 ===")
    print(f"风格声明：{vd.get('style_statement', '')}")
    print(f"年代感：{vd.get('era_note', '(未提取)')}")
    print(f"完整词典已存：bridge/visual-dict-{pid}.json（供第二阶段视听单元复用）")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pid")
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--model", default="glm-4.6")
    a = ap.parse_args()
    globals()["BASE"] = a.base.rstrip("/") + "/api/v1"
    run(a.pid, a.model)
