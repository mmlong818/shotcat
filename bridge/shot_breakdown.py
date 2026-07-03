#!/usr/bin/env python3
"""镜头级分镜：把剧本按【镜头】(不是场景)拆解——一个场景含多个镜头
(建立/过肩/特写/插入/反应…)。写进 shots + shot_details，并映射到场景实体。
时长由内容决定，不锁固定秒数。
用法：python shot_breakdown.py <project_id> [--model glm-4.6]
（会替换该项目章节内的现有镜头，先用 clear_shots 清旧镜头再跑）
"""
from __future__ import annotations
import argparse, json, time, urllib.error, urllib.request
from pathlib import Path
from glm import chat_json

SHOTS = "ECU 大特写 / CU 特写 / MCU 中近景 / MS 中景 / MLS 中远景 / LS 远景 / ELS 大远景"
ANGLES = "EYE_LEVEL 平视 / HIGH_ANGLE 俯 / LOW_ANGLE 仰 / BIRD_EYE 鸟瞰 / DUTCH 荷兰式 / OVER_SHOULDER 过肩"
MOVES = "STATIC 固定 / PAN 横摇 / TILT 纵摇 / DOLLY_IN 推 / DOLLY_OUT 拉 / TRACK 跟移 / CRANE 摇臂 / HANDHELD 手持 / STEADICAM 稳定器 / ZOOM_IN 变焦推 / ZOOM_OUT 变焦拉"

SYS = f"""你是专业分镜师。把剧本拆成【镜头级】分镜。
铁律：一个场景通常包含多个镜头（建立镜头/主镜头/过肩/正反打/特写/插入镜头/反应镜头/切出等），
绝不能一个场景只给一个镜头。按合理的视觉叙事节奏切分，时长由内容决定，不锁固定秒数。

镜头搭配参考：
- 进入新场景先给建立镜头(LS/ELS)交代空间；
- 对话用 过肩(OVER_SHOULDER)+正反打，情绪点切人物特写(CU/ECU)反应；
- 关键物件给插入特写(CU/ECU)；情绪爆发可推镜(DOLLY_IN/ZOOM_IN)。

每个镜头字段：
- scene：所属场景名（必须用给定场景名之一）
- title：该镜头一句话动作概述（≤16字）
- camera_shot：景别代码，仅用 [{SHOTS}] 的英文代码(如 CU)
- angle：机位代码，仅用 [{ANGLES}] 的英文代码
- movement：运镜代码，仅用 [{MOVES}] 的英文代码
- action：该镜头的画面/动作描述（一句话，可含表演）
- dialogue：该镜头对白原文，无则空字符串
- duration：建议秒数(整数)
- characters：该镜头出场角色名数组"""

USER_TMPL = """【完整剧本】
{script}

【本项目场景（scene 字段须用这些名）】{scenes}
【角色】{chars}

把全剧本拆成镜头级分镜。短片每个场景一般 3-6 个镜头。
输出 JSON：{{"shots":[{{"scene":"","title":"","camera_shot":"","angle":"","movement":"","action":"","dialogue":"","duration":6,"characters":[]}}]}}"""

BASE = "http://localhost:8000/api/v1"

VALID_SHOT = {"ECU", "CU", "MCU", "MS", "MLS", "LS", "ELS"}
VALID_ANGLE = {"EYE_LEVEL", "HIGH_ANGLE", "LOW_ANGLE", "BIRD_EYE", "DUTCH", "OVER_SHOULDER"}
VALID_MOVE = {"STATIC", "PAN", "TILT", "DOLLY_IN", "DOLLY_OUT", "TRACK", "CRANE", "HANDHELD", "STEADICAM", "ZOOM_IN", "ZOOM_OUT"}


def _norm(v, valid, default):
    v = (v or "").strip().upper()
    return v if v in valid else default


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


def items(path):
    _, j = _req("GET", path)
    return (j.get("data") or {}).get("items", [])


def run(pid: str, model: str):
    chapters = sorted(items(f"/studio/chapters?project_id={pid}&page_size=100"), key=lambda c: c.get("index", 0))
    if not chapters:
        raise SystemExit("无章节")
    ch = chapters[0]  # 短片单章节；多集可扩展为逐章
    script = "\n\n".join(c.get("raw_text", "") for c in chapters)
    scenes = items(f"/studio/entities/scene?project_id={pid}&page_size=100")
    chars = items(f"/studio/entities/character?project_id={pid}&page_size=100")
    scene_id_by_name = {s["name"]: s["id"] for s in scenes}
    char_id_by_name = {c["name"]: c["id"] for c in chars}

    # 清掉该章节现有镜头(可重跑)：先删 detail 再删 shot
    old = items(f"/studio/shots?chapter_id={ch['id']}&page_size=100")
    for o in old:
        _req("DELETE", f"/studio/shot-details/{o['id']}")
        _req("DELETE", f"/studio/shots/{o['id']}")
    if old:
        print(f"  已清除旧镜头 {len(old)} 个")

    print(f"[镜头级分镜] 项目 {pid}｜章节 {ch['id']}｜场景 {len(scenes)}｜模型 {model}")
    print("  GLM 拆镜头中…")
    data = chat_json(SYS, USER_TMPL.format(
        script=script, scenes="、".join(scene_id_by_name), chars="、".join(c["name"] for c in chars),
    ), model=model, temperature=0.6, timeout=300)
    shots = data.get("shots", [])
    if not shots:
        raise SystemExit("GLM 未产出镜头")
    Path(__file__).with_name(f"shots-{pid}.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  GLM 产出 {len(shots)} 个镜头（原场景数 {len(scenes)}）")

    ok_shot = ok_detail = 0
    for i, s in enumerate(shots, 1):
        sid = f"{ch['id']}__shot_{i:03d}"
        c1, _ = _req("POST", "/studio/shots", {
            "id": sid, "chapter_id": ch["id"], "index": i,
            "title": s.get("title", f"镜头{i}"), "script_excerpt": s.get("action", ""), "status": "pending",
        })
        if c1 >= 400:
            print(f"    镜{i} shot 建失败 {c1}"); continue
        ok_shot += 1
        detail = {
            "id": sid,
            "camera_shot": _norm(s.get("camera_shot"), VALID_SHOT, "MS"),
            "angle": _norm(s.get("angle"), VALID_ANGLE, "EYE_LEVEL"),
            "movement": _norm(s.get("movement"), VALID_MOVE, "STATIC"),
            "duration": int(s.get("duration") or 5),
            "action_beats": [b for b in [s.get("action"), s.get("dialogue")] if b],
        }
        sid_scene = scene_id_by_name.get(s.get("scene", ""))
        if sid_scene:
            detail["scene_id"] = sid_scene
        # 仅在 400(父 shot 尚未提交的时序缝隙)重试；422 是校验错，不重试
        c2 = 400
        for _try in range(10):
            c2, r2 = _req("POST", "/studio/shot-details", detail)
            if c2 != 400:
                break
            time.sleep(1.2)
        if c2 < 400:
            ok_detail += 1
        # 关联出场角色(供画面提示词/参考图按对应角色生成)
        for k, nm in enumerate(s.get("characters", []) or []):
            cid = char_id_by_name.get(nm)
            if cid:
                for _t in range(6):
                    lc, _ = _req("POST", "/studio/shot-character-links", {"shot_id": sid, "character_id": cid, "index": k})
                    if lc != 400:
                        break
                    time.sleep(1.0)
        print(f"    镜{i:>2} [{s.get('camera_shot','?')}/{s.get('movement','?')}] {s.get('title','')[:16]}"
              + f" 角色{s.get('characters',[])}" + (f"  (detail 失败 {c2})" if c2 >= 400 else ""))

    print(f"\n=== 完成：{ok_shot} 镜头 / {ok_detail} 含景别机位详情，写入章节 {ch['id']} ===")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pid")
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--model", default="glm-4.6")
    a = ap.parse_args()
    globals()["BASE"] = a.base.rstrip("/") + "/api/v1"
    run(a.pid, a.model)
