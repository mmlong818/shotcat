from __future__ import annotations

from app.models.studio import ShotFrameType
from app.schemas.studio.shots import ShotFramePromptMappingRead, ShotLinkedAssetItem
from app.services.studio.generation.shared.types import GenerationContext


def build_ordered_shot_frame_references(
    *,
    items: list[ShotLinkedAssetItem],
) -> list[ShotFramePromptMappingRead]:
    """按请求入参顺序构造稳定的图片映射关系。"""
    mappings: list[ShotFramePromptMappingRead] = []
    seen_file_ids: set[str] = set()
    for item in items or []:
        file_id = (item.file_id or "").strip()
        if not file_id or file_id in seen_file_ids:
            continue
        seen_file_ids.add(file_id)
        mappings.append(
            ShotFramePromptMappingRead(
                token=f"图{len(mappings) + 1}",
                type=item.type,
                id=item.id,
                name=(item.name or "").strip() or item.id,
                file_id=file_id,
            )
        )
    return mappings


class FrameGenerationContext(GenerationContext):
    """分镜帧图片生成的动态上下文。"""

    kind: str = "frame"
    shot_id: str
    frame_type: ShotFrameType
    images: list[ShotLinkedAssetItem]
    ordered_refs: list[ShotFramePromptMappingRead]


def build_frame_context(
    *,
    shot_id: str,
    frame_type: ShotFrameType,
    items: list[ShotLinkedAssetItem],
) -> FrameGenerationContext:
    return FrameGenerationContext(
        shot_id=shot_id,
        frame_type=frame_type,
        images=items or [],
        ordered_refs=build_ordered_shot_frame_references(items=items),
    )

