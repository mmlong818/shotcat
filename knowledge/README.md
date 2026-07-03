---
摘要: duanju-studio 知识包索引。raw/ 是从 yuandian 最新版原样抢救的知识资产(仅数据/prompt，不含其 App 代码)。story-bible.schema.v1.json 是编剧端与 Jellyfish 生产端的共享契约。本文给出资产清单与"故事圣经↔Jellyfish 实体"精确映射表。
来源: ref
日期: 2026-07-01
关联: story-bible.schema.v1.json
---

# 知识包（knowledge）

## 来源与边界
- 全部提炼自 **yuandian**（github.com/mmlong818/yuandian-screenwriting-system，最新版 14M/218 文件）。
- **只取纯知识资产（JSON / data-first JS / md），丢弃其全部 App 代码**（server.js / SQLite / 前端 / render / handlers）—— 即"体量过大不学"的部分。
- `raw/` 保留原始格式，后续可按需转成统一 JSON；当前阶段直接当 prompt 燃料引用即可。

## raw/ 资产清单
| 文件 | 内容 | 用途 |
|---|---|---|
| `beatSheetLibrary.js` (59K) | 3 套节拍表：Save the Cat 15拍 / 英雄之旅 12段 / **chinese_drama_24ep 24集短剧逐集公式** | 编剧结构燃料。每拍带 dramatic_function/must_include/failure_modes/ai_instruction |
| `storyStructureLibrary.js` (111K) | 14 种叙事结构（三幕/四幕/五幕/序列/故事圈/多线/非线性…） | 结构选择 + 节点清单 |
| `genreLibrary.js` (41K) | 12 类型：每类 obligatory_scenes(必备场景) + forbidden_patterns(禁用套路) + chinese_market_notes(短剧市场备注) | 类型契约校验 |
| `seriesLibrary.js` (5K) | 剧集/系列库（最新版新增） | 短剧/剧集专项 |
| `characterArchetypeLibrary.js` (35K) | 角色原型（欲望/恐惧/伤口/弧光选项/关系动力/中式变体）——**取自旧本地版，最新版已移除** | 建角色素材 |
| `story-bible-template-v1.json` | 故事圣经原始模板 | 我方 schema 的蓝本 |
| `plot-driven-project-template-v1.json` | 剧情板/锁定/影响追踪模型 | 可选进阶：改动传播追踪 |
| `rules-v1.json` | 12 条规则引擎（含 pass_condition/suggested_next_step） | 剧本体检 |
| `writing-rules-checklist.md` | 8 层质量框架 + 100分制 + 自动不合格条件 | 人工/AI 复核清单 |
| `yuandian-lessons.md` | 编剧系统实战教训（尤其"内容级矛盾=正典块+定向重生成"） | 避坑 |

## ★ 故事圣经 ↔ Jellyfish 实体 映射表

编剧端产出 `story_bible.json`（遵循 `story-bible.schema.v1.json`），bridge 按下表灌进 Jellyfish（`app/backend/app/models/studio_assets.py`）。**ID 天生同构**（char_001 / scene_001），是整条链一致性的关键。

| 故事圣经字段 | → Jellyfish 表.字段 | 说明 |
|---|---|---|
| `characters[].id` (char_001) | `characters.id` | 直接沿用 |
| `characters[].name` | `characters.name` | 项目内唯一，全程原样保留 |
| `characters[].appearance` (+ 必要时叙事摘要) | `characters.description` | **视觉描述**驱动图片生成；缺失可由 CharacterPortraitAnalysisAgent 补 |
| `characters[].default_costume` | `costumes` 表 + `characters.costume_id` | 按 name 去重建服装后绑定 |
| `characters[].props[]` | `props` 表 + `character_prop_links` | 按 name 去重建道具后绑定 |
| `scenes[].id/name/visual_description` | `scenes.id/name/description` | 地点场景；name **全局唯一** |
| `props[].id/name/visual_description` | `props.id/name/description` | 全局道具；name 全局唯一 |
| `project.visual_style` | 各实体 `.visual_style` | live_action / anime |
| `project.style` | 各实体 `.style` | 题材/风格，各实体必填 |
| `script.episodes[].body` | `chapters` + `POST /script-processing/divide-async(script_text, chapter_id, write_to_db=true)` | 每集建章节 → 切分镜 |

**只在编剧端消费、Jellyfish 无对应表（不迁移）**：external_want/internal_need/wound/arc、relationships、world_rules、timeline_events、beats、scene_cards、setup_payoffs。它们负责"把故事写扎实"和"规则体检"，是 divide 分镜时喂给 LLM 的上下文，不落生产实体表。

## 待办（后续期）
- [ ] 把 raw/*.js 的数据部分转成统一 JSON（去掉 ES export 包装），便于任意语言消费
- [ ] chinese_drama_24ep 节拍表单独抽成 `beat-sheets.micro.json`（短剧主力）
- [ ] 12 类型的 obligatory_scenes/forbidden_patterns 抽成校验用结构
