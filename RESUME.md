# 下次接上 · 快速指南（猫叔的短剧工作台）

工作区：`D:\CC\projects\duanju-studio`

## 1. 启动服务（两条）
```bash
# ① 后端全栈（Jellyfish：MySQL/Redis/RustFS/后端8000/Celery）——Docker Desktop 要先开着
cd D:/CC/projects/duanju-studio/app/deploy/compose
docker compose --env-file .env -f docker-compose.yml up -d

# ② 新前端（黑金界面，核心流程）
cd D:/CC/projects/duanju-studio/web
pnpm dev      # → http://localhost:5273
```
- 前端：http://localhost:5273 ｜ 后端 API：http://localhost:8000 ｜ 旧 Jellyfish 前端：http://localhost:7788（后台页用）

## 2. 验证是否正常
- 打开 http://localhost:5273 → 应看到黑金界面、项目"替身总裁的辞职信"
- 分镜页有镜头卡；双击 → 画面工作台 → 点"生成"能出 AI 图（关键帧此前已生成过一张）
- 若前端报错/无数据：确认后端 200：`curl http://localhost:8000/openapi.json`

## 3. 当前进度（做到哪了）
- ✅ 后端底座 = Jellyfish（Docker 跑通）
- ✅ LLM：GLM 接入。**默认文本模型 glm-4.6、默认图像模型 gpt-image-2**（存后端 DB）
- ✅ 桥 `bridge/import_to_jellyfish.py`：故事圣经 JSON → 项目+造型+分镜
- ✅ 新前端 `web/`：黑金好莱坞风，三大页全部接真实数据
  - 分镜·时序图 / 造型 / 画面工作台（双击镜头卡联动）
- ✅ **画面生成全链路打通**：shot → GLM提示词 → gpt-image-2 → RustFS → 显示（真机出过图）

## 4. 下次可做（按优先级）
1. **桶自动加固**：storage 上传前 ensure-bucket，或 compose 加建桶步骤（现在桶是手建的，换新环境会再踩坑）——详见 PLAN.md「画面生成接线」
2. 造型页"生成造型图"按钮接线（同 image-task 套路）
3. 剧本页（接原点导入 + 分集浏览 + 触发拆分镜）
4. 修场景过滤（Jellyfish Scene 全局表，entities/scene?project_id 会串入他项目场景 → 按 ProjectSceneLink 过滤）
5. 首帧/尾帧批量生成、生成进度接任务中心

## 5. 关键位置
- 规划与踩坑全记录：`PLAN.md`
- 设计稿：`design/`（DESIGN.md + redesign-*.html + web-*.png 预览）
- 前端代码：`web/src/`（App.tsx 外壳、pages/ 三页、lib/api.ts、theme.css 黑金主题）
- 后端改动（都在 Jellyfish 源码内，已重建镜像）：
  - `app/backend/app/services/studio/image_task_runner.py`（超时180s + b64落库）
  - `app/backend/app/core/storage.py`（S3 path 寻址）
  - GLM/图像模型配置在后端 DB（`/api/v1/llm/*`）
- GLM key：`（已配置在后端 DB 与 web 无关）`；如需重配见 PLAN.md「GLM 接入方式」

## 6. 重要坑备忘
- `docker compose up --build front/backend` 会**连带重启 backend**，勿与 bridge/生成任务并发
- `PUT /api/v1/llm/model-settings` 是**整行替换**，改任一默认模型必须同时带 text+image，否则冲掉另一个
- Windows CRLF 会让前端脚本挂（已修 LF）；MySQL 端口用的是 3307（3306 被占）
