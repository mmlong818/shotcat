#!/usr/bin/env python3
"""镜头级分镜：把剧本按【镜头】(不是场景)拆解——一个场景含多个镜头
(建立/过肩/特写/插入/反应…)。写进 shots + shot_details，并映射到场景实体。
时长由内容决定，不锁固定秒数。
用法：python shot_breakdown.py <project_id> [--model glm-4.6]
（会替换该项目章节内的现有镜头，先用 clear_shots 清旧镜头再跑）
"""
from __future__ import annotations
import argparse, json, re, time, urllib.error, urllib.request
from pathlib import Path
from glm import chat_json
from http_util import get_all

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
- time：该镜头故事时间，仅用 [日/夜/晨/黄昏] 之一；剧本写"持续/稍后"时延续上一场的时间
- space：内 或 外（室内/室外）
- title：该镜头一句话动作概述（≤16字）
- camera_shot：景别代码，仅用 [{SHOTS}] 的英文代码(如 CU)
- angle：机位代码，仅用 [{ANGLES}] 的英文代码
- movement：运镜代码，仅用 [{MOVES}] 的英文代码
- action：**镜头里看见什么**：画面主体是谁/什么、空间位置关系（前座/后座、左/右、前景/背景）、正在发生的动作。
  写"画面"不写"剧情"；无人物的空镜必须以"空镜："开头（如"空镜：雨点砸在挡风玻璃上，雨刮器静止"）
- dialogue：该镜头对白原文，无则空字符串
- duration：建议秒数(整数)。有对白的镜头必须容纳朗读时间：常规语速每秒 4 字（慢速抒情戏每秒 3 字），
  即 duration ≥ 对白字数÷4，再加动作/反应的余量
- characters：**画面中出现的所有角色**名数组（不是"镜头主体"）：过肩镜头必须包含被借肩的背影角色；
  双人同框(对峙/对坐/并行)必须两人都列；只有画外音/完全不在画内才不列

【镜头语言多样性硬约束（必须满足，先规划配比再输出）】
1. 固定机位(STATIC)占比不得超过全片镜头的 40%；其余用运动镜头(PAN/TILT/DOLLY_IN/DOLLY_OUT/TRACK/CRANE/HANDHELD/ZOOM_IN/ZOOM_OUT)。
2. 每进入一个新场景，其建立镜头必须是运动镜头(优先 DOLLY_IN/TRACK/PAN/CRANE)交代空间，不得用 STATIC。
3. 每一组双人对话，必须至少包含一组过肩正反打：两个相邻镜头 angle 均为 OVER_SHOULDER 且互为反打。
4. 机位角度不得全程 EYE_LEVEL：压迫/俯视用 HIGH_ANGLE，弱势/仰望用 LOW_ANGLE，情绪失衡可用 DUTCH。
5. 情绪爆点或信息落点镜头，用推镜(DOLLY_IN)或特写(CU/ECU)强化。"""

USER_TMPL = """【完整剧本】
{script}

【本项目场景（scene 字段须用这些名）】{scenes}
【角色】{chars}

把全剧本拆成镜头级分镜。短片每个场景一般 3-6 个镜头。
输出 JSON：{{"shots":[{{"scene":"","time":"日","space":"内","title":"","camera_shot":"","angle":"","movement":"","action":"","dialogue":"","duration":6,"characters":[]}}]}}"""

BASE = "http://localhost:8000/api/v1"

VALID_SHOT = {"ECU", "CU", "MCU", "MS", "MLS", "LS", "ELS"}
VALID_ANGLE = {"EYE_LEVEL", "HIGH_ANGLE", "LOW_ANGLE", "BIRD_EYE", "DUTCH", "OVER_SHOULDER"}
VALID_MOVE = {"STATIC", "PAN", "TILT", "DOLLY_IN", "DOLLY_OUT", "TRACK", "CRANE", "HANDHELD", "STEADICAM", "ZOOM_IN", "ZOOM_OUT"}


def _norm(v, valid, default):
    v = (v or "").strip().upper()
    return v if v in valid else default


_DLG_PUNCT = re.compile(r"[「」『』“”\s，。！？；：、…—·,.!?;:]")


def _dlg_min_secs(dialogue):
    """对白朗读时间下限：常规语速每秒 4 字（去引号/标点后计字，向上取整）。"""
    n = len(_DLG_PUNCT.sub("", dialogue or ""))
    return (n + 3) // 4 if n else 0


def _duration(v, dialogue=None):
    """容错解析建议秒数：提取前导数字(如 '6秒' → 6)，缺省 5；
    有对白时下限抬到朗读时间(常规每秒4字)，夹到 1-60。"""
    if isinstance(v, (int, float)):
        n = int(v)
    else:
        m = re.match(r"\s*(\d+)", str(v or ""))
        n = int(m.group(1)) if m else 5
    return max(1, min(60, max(n, _dlg_min_secs(dialogue))))


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
    return get_all(BASE, path)


def run(pid: str, model: str):
    chapters = sorted(items(f"/studio/chapters?project_id={pid}&page_size=100"), key=lambda c: c.get("index", 0))
    if not chapters:
        raise SystemExit("无章节")
    ch = chapters[0]  # 短片单章节；多集可扩展为逐章
    script = "\n\n".join(c.get("raw_text", "") for c in chapters)
    if not script.strip():
        raise SystemExit("项目无剧本正文，请先在剧本页粘贴剧本（避免空剧本白调 GLM）")
    scenes = items(f"/studio/entities/scene?project_id={pid}&page_size=100")
    chars = items(f"/studio/entities/character?project_id={pid}&page_size=100")
    scene_id_by_name = {s["name"]: s["id"] for s in scenes}
    char_id_by_name = {c["name"]: c["id"] for c in chars}

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

    # 先完整校验整份镜头表，全部通过才动数据库（避免删了旧镜头却建不出新的、留下空章节）
    for i, s in enumerate(shots, 1):
        if not (s.get("title") or "").strip() or not (s.get("action") or "").strip():
            raise SystemExit(f"镜{i} 缺必填字段(title/action)，中止（未改动数据库）")

    # 空镜前缀不依赖 GLM 遵守（实测遵守率低）：characters 为空且 action 未以"空镜"开头则后处理补上，
    # 供下游帧提示词识别为无人物镜头。
    for s in shots:
        act = (s.get("action") or "").strip()
        if not (s.get("characters") or []) and act and not act.startswith("空镜"):
            s["action"] = "空镜：" + act

    # 校验通过后再清该章节现有镜头(可重跑)：先删 detail 再删 shot；任一失败即中止，不谎报已清除
    old = items(f"/studio/shots?chapter_id={ch['id']}")
    for o in old:
        cd, _ = _req("DELETE", f"/studio/shot-details/{o['id']}")
        if cd >= 400 and cd != 404:
            raise SystemExit(f"删除旧镜头详情 {o['id']} 失败(HTTP {cd})，中止以免新旧数据混杂")
        cs, _ = _req("DELETE", f"/studio/shots/{o['id']}")
        if cs >= 400 and cs != 404:
            raise SystemExit(f"删除旧镜头 {o['id']} 失败(HTTP {cs})，中止以免新旧数据混杂")
    if old:
        print(f"  已清除旧镜头 {len(old)} 个")
    # 注：后端 shot-character-links 无 DELETE 接口(仅 GET/POST-upsert)，旧镜头的角色关联
    # 依赖删 shot 时的级联清理；新镜头 id 与旧镜头按 index 复用同名，POST 为 upsert 会覆盖。

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
            "duration": _duration(s.get("duration"), s.get("dialogue")),
            # 对白包「」入库：下游(分镜展示/帧提示词)可明确区分动作与台词
            "action_beats": [b for b in [
                s.get("action"),
                (lambda d: d and (d if d.startswith("「") else f"「{d}」"))((s.get("dialogue") or "").strip()),
            ] if b],
            # 场次时间/内外景：ShotDetail 无专用字段，按 "时:X"/"景:X" 约定存 mood_tags
            # （mood_tags 会进帧提示词链，时间与内外景本身也是画面生成的关键信息）
            "mood_tags": [t for t in [
                f"时:{s.get('time')}" if s.get("time") in {"日", "夜", "晨", "黄昏"} else None,
                f"景:{s.get('space')}" if s.get("space") in {"内", "外"} else None,
            ] if t],
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
