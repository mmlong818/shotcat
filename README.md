# 猫叔的短剧工作台（duanju-studio）

**剧本到来之后**的短剧生产工具。编剧不在范围内（那是「原点编剧系统」的活，做完我们接）。
视觉方向：暗色专业创作台（近黑 + 琥珀金）。设计稿见 `design/`。

本工具负责的链路：
```
剧本(原点产出) → 造型/场景/道具/服装设置 → 文字分镜 → 图像分镜 → 图生视频（最远到此）
```

## 结构
```
duanju-studio/
├── app/          平台 底座（生产平台：分镜/资产/关键帧/图生视频，React+FastAPI）
├── bridge/       剧本接入桥（story-bible.json → 平台 项目+造型资产+文字分镜）
├── knowledge/    story-bible.schema.v1.json = 与原点的交接契约（其余知识库为写作侧参考，本工具不用）
├── _archive/     已作废的编剧模块（screenwriter，保留备查）
└── PLAN.md       落地规划与进度
```

## 与原点的关系
- **原点**产出剧本 + 结构化设定（角色/场景等）。
- 交接格式 = `knowledge/story-bible.schema.v1.json`（角色 char_001 / 场景 scene_001，与 平台 实体同构）。
- 原点完成后，其输出映射到本 schema，经 `bridge` 一键进入生产。当前可用手写/样例 story-bible 先跑通生产侧。

## 现状
生产链路前半段已通：`bridge` 能把剧本 → 项目+造型资产+文字分镜（Celery 异步切镜）。
下一步：接入**图像模型**（造型图 + 图像分镜）与**视频模型**（图生视频）。详见 `PLAN.md`。

## 启动 平台
`cd app/deploy/compose && docker compose --env-file .env -f docker-compose.yml up -d`
前端 http://localhost:7788 ｜ 后端 http://localhost:8000
