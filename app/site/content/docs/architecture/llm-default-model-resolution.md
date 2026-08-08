---
title: "LLM 默认模型解析"
weight: 35
description: "当前生效的 LLM 默认模型来源与解析顺序。"
---

本文记录当前真实生效的默认模型规则（text / image / video）。

## 单一事实来源

- 默认模型统一由 `model_settings` 单例表维护：
  - `default_text_model_id`
  - `default_image_model_id`
  - `default_video_model_id`
- `models` 表不再承担“默认模型”语义，`models.is_default` 已下线。

## 解析规则

- 运行时按类别读取 `model_settings` 对应字段。
- 若对应默认模型 ID 未配置，服务返回 `503`（`No default model configured for category=...`）。
- 若配置了模型 ID 但模型不存在，服务返回 `503`（`Configured default model not found: ...`）。

## 管理入口

- 默认模型仅通过 `LLM Model Settings` 接口维护（`/api/v1/llm/model-settings`）。
- 模型列表（`/api/v1/llm/models`）仅维护模型实体信息（名称、类别、供应商、参数等），不再提供默认切换语义。

## 工作台启动检查

- 日常工作台启动时调用 `/api/v1/llm/initial-setup`，分别检查默认文字模型和默认图片模型。
- 每一类模型必须同时满足：默认模型存在、类别正确、供应商受支持且未停用、必需的 API Key 已保存。
- 任一类别未就绪时，工作台会阻止生成操作并显示首次配置界面；文字与图片可分别选择供应商、模型 ID、API 地址和 Key。
- 保存接口在同一数据库事务中写入供应商、模型和 `model_settings` 默认值。已就绪的类别不会被首次配置流程覆盖。
- 状态接口只返回 `has_api_key` 布尔值，不回传或记录明文 Key；不同类别使用独立供应商记录，因此即使选择同一家服务商，也可以保存不同 Key。
