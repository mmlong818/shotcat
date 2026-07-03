---
摘要: 短剧一体化工具落地规划。目标：一个工具从创意→剧本→分镜→素材→关键帧→视频。平台 当底座(app/)，yuandian 提炼知识包(knowledge/)，BIANJU 风格编剧工作流(screenwriter/)，bridge/ 打通剧本→生产。分三期推进。
来源: self
日期: 2026-07-01
关联: knowledge/story-bible.schema.v1.json
---

# 短剧一体化工具 · 落地规划

## 目标（2026-07-01 范围收缩：去掉编剧，只做剧本之后的生产）
编剧交给「原点编剧系统」，做完我们接。本工具聚焦**剧本到来之后**：
```
剧本(原点产出) → 造型/场景/道具/服装设置 → 文字分镜 → 图像分镜 → 图生视频（最远到此）
```
交接契约 = story-bible.schema.v1.json（角色 char_001/场景 scene_001，与 平台 实体同构），
一致性从原点交接的那一刻锁死，贯穿到分镜与成图。

> 原编剧模块（screenwriter/）已作废，移入 _archive/。第 2 期「编剧」相关内容仅作历史记录。

## 定位
- **app/** = 平台 底座（React+FastAPI+MySQL+Redis+RustFS+Celery）。造型/分镜/关键帧/图生视频全套生产线。尽量不改源码。
- **bridge/** = 剧本接入桥：story-bible.json → 项目 + 造型资产(角色/场景/道具/服装) + 文字分镜(divide)。
- **knowledge/** = story-bible.schema.v1.json 为与原点的交接契约；其余（节拍表/类型/原型）是写作侧参考，本工具不用。
- **_archive/screenwriter/** = 已作废的编剧模块（原点负责编剧，故移除）。

## 生产链路四段（本工具范围）
1. 造型/场景/道具/服装设置 —— 资产实体 + 形象图（需图像模型）
2. 文字分镜 —— divide 切镜 ✅ 已通（异步 Celery + glm-4.6）
3. 图像分镜 —— 首/尾/关键帧图（需图像模型）
4. 图生视频 —— image-to-video（需视频模型），最远到此

## 进度

### 第 0 期：地基 【已完成 ✅】
- [x] 建工作区骨架 duanju-studio/{app,knowledge,screenwriter,bridge}
- [x] 抢救 yuandian 知识资产 → knowledge/raw/（10 个文件）
- [x] 定稿共享契约 knowledge/story-bible.schema.v1.json（叙事层+视觉层，ID 与 平台 同构）
- [x] 故事圣经 ↔ 平台 实体映射表（knowledge/README.md）
- [x] **本地跑通 平台**（docker-compose，全栈健康）
- [x] 验证：openapi 200、`GET /api/v1/studio/projects` 200、前端 7788 200

#### 环境备忘（复现/重启用）
- 启动：`cd app/deploy/compose && docker compose --env-file .env -f docker-compose.yml up -d`
- 访问：前端 http://localhost:7788 ｜ 后端 http://localhost:8000 ｜ RustFS 控制台 :9001
- **坑1**：宿主 3306 被本机 MySQL 占用 → `.env` 里 MYSQL_PORT 改 3307（容器内仍 3306，无影响）
- **坑2**：Windows 检出把 `deploy/docker/docker-entrypoint.d/10-generate-env-js.sh` 变成 CRLF，导致前端 `env: can't execute 'sh'`。已 `sed -i 's/\r$//'` 修成 LF。若重新 clone 需再修（建议加 .gitattributes 锁 *.sh eol=lf）。
- LLM：已接入 **GLM-5.2** 为默认文本模型（走 openai 兼容通道，验证已通）。

#### GLM 接入方式（已配置，重建库后需重跑）
GLM 无原生适配器，走 **openai 兼容通道**（provider.name 必须填 `openai` 才能命中适配器；base_url 换成 GLM 端点）。三步 API：
1. `POST /api/v1/llm/providers`  → id=glm, name=**openai**, base_url=`https://open.bigmodel.cn/api/paas/v4`, api_key=<GLM key>, status=active
2. `POST /api/v1/llm/models`  → id=glm-5-2, name=`glm-5.2`, category=text, provider_id=glm
3. `PUT /api/v1/llm/model-settings`  → default_text_model_id=glm-5-2
- **坑3**：curl 传含中文/引号的 JSON 会被 shell 转义搞坏（"error parsing the body"）→ 用 Python urllib 或 `--data @file` 发请求。
- **验证已通**：`POST /script-processing/divide` 用测试剧本 9s 返回 4 个结构化镜头。

### 第 0 期 全部完成 ✅（含 GLM 接入与真跑验证）

### 第 1 期：打通生产链路（MVP）【已完成 ✅】
- [x] 写 bridge/import_to_jellyfish.py：读 story_bible.json → 建项目/场景/道具/服装/角色 → 每集建章节并切分镜
- [x] 样例故事圣经 bridge/sample-story-bible.json（替身总裁的辞职信）
- [x] 端到端验证：1 条命令 → 项目+2角色(带服装绑定)+场景+道具+第1集切出 5 个分镜，全部落库

#### 用法
`cd bridge && python import_to_jellyfish.py sample-story-bible.json`（加 `--async` 走 Celery）

#### 第 1 期踩坑（平台 commit-after-yield 时序缝隙）
平台 的 DB 会话在 HTTP 响应发出后才提交，桥紧接着建子对象时父对象可能还没落地（报 "Project/Costume not found"）。
解法：桥在建项目/章节/服装后 `wait_get` 轮询直到 GET 200 再建子对象；创建统一走 create_idempotent（"已存在"跳过，可重跑）。

### 第 2 期：编剧模块（创意→故事圣经→生产）【核心已完成 ✅】
- [x] 知识包 .js → JSON（node 转换）：beat-sheets/genres/archetypes/structures.json
- [x] screenwriter/glm_client.py（GLM OpenAI 兼容客户端，key 走 .glm_key/env，gitignore）
- [x] screenwriter/knowledge.py（类型必备场景/节拍表/原型注入 prompt）
- [x] screenwriter/generate.py（4 阶段：内核→角色→场景道具→逐集正文；ID 在 Python 侧分配保证一致性）
- [x] 端到端：`generate.py "创意" --genre suspense_crime --episodes 2 --import`
      → 生成《解剖室里的最后一课》→ 桥导入 → worker 切 11 个分镜，全链路通
- [ ] （剩余）把 generate 包成 平台 内的「剧本创作」页，实现单一 UI（见第 3 期）

#### 用法
`cd screenwriter && python generate.py "一句创意" --genre <类型id> --episodes N --import`

#### 第 2 期关键教训
- **模型分工**：divide/extract 等结构化任务用 **glm-4.6**（快）；创意编剧用 **glm-5.2**（质量）。
  glm-5.2 跑 900 字 divide 超 300s——重推理不适合高频结构化任务。已把 平台 默认文本模型设为 glm-4.6。
- **divide 必须走异步**：同步 /divide 在 web 进程内跑 LLM，会阻塞 event loop 卡死整个后端。
  桥已默认 `divide-async`（Celery worker），投递后轮询 shots 确认。`--sync` 仅调试用。
- **已知待优化（内容质量，不阻塞）**：① GLM 偶把节拍表里的"第X集"抄进标题；② 角色随身道具使道具数偏多(13)。

### UI 对齐原点（降低跨工具切换不适）【已完成 ✅】
- [x] 提取原点设计 token（app.css / workbench-color-system-spec）：暖纸底 #faf6ee、陶土橙 #b5601d、墨 #1b1813、衬线标题 Noto Serif SC、圆角 8px
- [x] 平台 antd 主题对齐：main.tsx ConfigProvider（colorPrimary=陶土橙 + Layout/Menu 暖色 token）
- [x] 全局皮肤 front/src/yuandian-theme.css（暖底 + 衬线标题 + 侧栏暖色 + 选中态陶土橙）
- [x] 重建 front，产物含 b5601d/faf6ee/Noto Serif，已生效
- 说明：仅外观层，不改业务组件；进一步逐页色相（结构页陶土灰/剧情板板岩蓝灰…）可后续按 spec 精修

### 图像/视频模型（图像分镜 + 图生视频）【待接入】
- [ ] 配置**图像模型**（造型图 + 首/尾/关键帧图）：平台 仅支持 openai / volcengine 图像通道
- [ ] 配置**视频模型**（图生视频）：平台 支持 openai / volcengine 视频通道
- 待用户定：用火山引擎（豆包 Seedream 图 + Seedance 图生视频，一 key 覆盖图+视频）还是 OpenAI 兼容 / 试 GLM CogView

### UI 重构落地（暗色专业创作台）
- [x] 步骤1 主题地基：antd darkAlgorithm + 琥珀 token + theme-dark.css；清除 App.css 遗留蓝色 #1890ff/#6366f1；品牌改名「猫叔的短剧工作台」（title 用亮色，原 text-gray-900 在暗底不可见已修）。真机验证琥珀主色全线生效。
- [ ] 步骤2 左轨改 4 段流程（剧本/造型/分镜/画面）+ 顶栏（品牌+进度+任务降级）
- [ ] 步骤3 分镜页改时序图（合并原分镜编辑页/工作室）
- [ ] 步骤4 造型页卡片库样式
- [ ] 步骤5 画面工作台（单镜头首/关/尾帧）
- 注意坑：`docker compose up --build front` 会连带重启 backend，勿与 bridge 并发；平台 多为浅色设计，各页仍有 text-gray-900/白底硬编码，步骤2-5 随页面重构一并转暗。
- **坑（重要）**：`PUT /api/v1/llm/model-settings` 是**整行替换**，只传部分字段会把其余默认模型冲成 null。配任一默认模型时必须同时带上 text+image(+video)。曾因只传 image 把 text 默认冲掉 → worker "No default model configured for category=text" → divide 失败并清空分镜。已修复：text=glm-4-6 + image=gpt-image-2。

### 画面生成接线（shot → 首/关/尾帧图）【已打通 ✅】
正确流程（已代码核实，无洞）：
1. `POST /film/tasks/shot-frame-prompts {shot_id, frame_type}` → 轮询 → `result.prompt`（基础提示词，落 ShotDetail.*_frame_prompt；需默认文本模型）
2. `POST /studio/image-tasks/shot/{shot_id}/frame-image-tasks {frame_type, prompt(必填), target_ratio(必填,如"16:9")}` → 轮询（需默认图像模型，503 在 POST 同步抛）
3. `GET /studio/shot-frame-images?shot_detail_id={shot_id}` → 按 frame_type 取 file_id（判空！占位行 file_id 可能为 null）
4. 显示：`GET /studio/files/{file_id}/download`（返回 PNG 字节，可直接 <img src>）
前置：shot 必须有 ShotDetail（bridge 的 divide 已自动建）；每帧单独生成；ShotFramePromptMapping 非 DB 表不用建。

**修复的 4 个真实漏洞（都在 app/ 源码，已重建镜像）：**
- 图像任务超时 60s→180s（`image_task_runner.py` 传 `timeout_s=180`；gpt-image-2 画大图常超 60s）
- b64 未落库（`_persist_images_to_assets` 原 `if not item.url: return` 丢弃了 gpt-image 的 b64_json；改为兼容 url/b64 并传 `b64_data`）
- S3 寻址（`storage.py` `addressing_style` virtual→**path**；RustFS 需路径式，虚拟主机式解析成 bucket.rustfs DNS 失败）
- 桶不存在（`jellyfish-assets` 未创建；已在 rustfs 建好，volume 持久。**待加固**：storage 上传前 ensure-bucket 或 compose 加建桶步骤）

前端 web/ 画面工作台"生成/重生成"按钮已接此链路（提示词失败自动退回剧本摘录；轮询进度；错误就地显示）。

### 第 3 期（可选）：单一 UI —— 真正"打开一个工具"
- [ ] 平台 前端加「剧本创作」页：输入创意 → 调 screenwriter → 展示故事圣经/正文 → 一键送生产
- [ ] 或做一个轻量本地 Web 壳把 generate+bridge 串起来（不改 平台 源码）

## 待用户拍板（阻塞第 0 期最后一步）
1. **Docker**：本地跑 平台 最省心靠 docker-compose；无 Docker 则走 dev 模式（Python uv + Node/pnpm）。
2. **LLM key**：编剧与分镜都要调 LLM，用哪个（GLM / OpenAI 兼容 / 火山引擎）。

## 关键约束
- 不学 yuandian 的 App 架构（体量过大），只用其知识资产。
- 平台 源码尽量不改，优先"加模块/加入口"而非侵入改造，便于日后拉上游更新。
- 角色/场景名全程原样保留，不改写（平台 硬约束，一致性根基）。
