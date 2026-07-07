# shotcat（duanju-studio）工作区规范

短剧一体化创作工具，plotcat 系列的生产层（plotcat 写故事，shotcat 拍故事）。目标见 `PLAN.md`。

## 三方定位（勿混淆）
- `app/` = 平台 底座。**尽量不改源码**，优先加模块/加入口。改前端接口后按其 AGENTS.md 跑 `pnpm run openapi:update`。日后可拉上游更新，故保持低侵入。
- `knowledge/` = 纯知识资产（来自 yuandian，**不引入其 App 代码**）。story-bible.schema.v1.json 是编剧端↔生产端的共享契约，改它必须同步 bridge 映射。
- `_archive/screenwriter/` = 已作废的编剧模块（编剧交给原点编剧系统，本工具只接剧本之后的生产）。
- `bridge/` = 唯一新写的胶水层，读故事圣经 → 调 平台 API。

## 铁律
- 角色/场景**名称全程原样保留**，不改写/翻译/换同义词（平台 一致性根基）。
- 实体 ID 用 char_001 / scene_001 / prop_001 约定（与 平台 EntityMerger 同构）。
- 不重复造 平台 已有能力（分镜/实体一致性/任务系统/图片视频生成）。
- 先跑通再优化：第 1 期先手写样例故事圣经验证桥，第 2 期再自动生成。

## 跑起来
- 平台：`app/deploy/compose/` docker-compose 一键，或 dev 模式（backend `uv run uvicorn app.main:app`，front `pnpm dev`）。
- 剧本入口 API：`POST /api/v1/script-processing/divide-async`（script_text + chapter_id + write_to_db）。

## 参考记忆
项目方向见便利贴 [[project_duanju_tool]]。
