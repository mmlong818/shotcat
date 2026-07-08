// 平台 后端 API 轻封装（dev 走 vite 代理 /api → :8000）
const BASE = '/api/v1'

async function get<T = any>(path: string): Promise<T> {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`GET ${path} ${r.status}`)
  const j = await r.json()
  return j.data ?? j
}

// POST：即使 4xx/5xx 也读出后端 message（{code,message,data}），失败抛带 message 的错误
async function post<T = any>(path: string, body: any): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let j: any = null
  try {
    j = await r.json()
  } catch {}
  if (!r.ok) throw new Error(j?.message || `POST ${path} ${r.status}`)
  return (j?.data ?? j) as T
}

export interface Project { id: string; name: string; description?: string; style?: string; visual_style?: string; progress?: number; default_video_ratio?: string }
export interface Chapter { id: string; index: number; title: string; project_id: string; raw_text?: string }
export interface Shot {
  id: string; index: number; chapter_id?: string; title?: string; status?: string; script_excerpt?: string
  camera_shot?: string; duration?: number; angle?: string; movement?: string; action_beats?: string[]; description?: string
  scene_id?: string | null; mood_tags?: string[]
}

// 镜头语言代码 → 中文（与后端 code、bridge/shot_breakdown 词表一致）
export const CAMERA_ZH: Record<string, string> = {
  ECU: '大特写', CU: '特写', MCU: '中近景', MS: '中景', MLS: '中远景', LS: '远景', ELS: '大远景',
}
export const ANGLE_ZH: Record<string, string> = {
  EYE_LEVEL: '平视', HIGH_ANGLE: '俯拍', LOW_ANGLE: '仰拍', BIRD_EYE: '鸟瞰', DUTCH: '荷兰角',
}
export const MOVE_ZH: Record<string, string> = {
  STATIC: '固定', PAN: '横摇', TILT: '纵摇', DOLLY_IN: '推', DOLLY_OUT: '拉', TRACK: '跟移',
  CRANE: '摇臂', HANDHELD: '手持', STEADICAM: '稳定器', ZOOM_IN: '变焦推', ZOOM_OUT: '变焦拉',
}
export interface Entity { id: string; name: string; description?: string; thumbnail?: string; costume_id?: string }
export interface FrameImage { id: number; shot_detail_id: string; frame_type: 'first' | 'key' | 'last'; file_id: string | null }
export interface TaskStatus { task_id: string; status: string; progress: number }
export interface AssetImageBatchStatus {
  batch_id: string
  status: string
  total: number
  queued: number
  running: number
  succeeded: number
  failed: number
  current?: string
  current_task_id?: string | null
  error?: string
  items: any[]
}
export type FrameType = 'first' | 'key' | 'last'

interface Paged<T> { items: T[]; pagination: { total: number; max_page?: number } }

export const fileUrl = (fileId: string) => `${BASE}/studio/files/${fileId}/download`

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

const cleanRefName = (name: string | undefined, fallback: string) =>
  String(name || fallback)
    .replace(/[-－_ ]?默认服装[（(][^）)]+[）)]/g, '')
    .replace(/[-－_ ]?默认服装/g, '')
    .trim() || fallback

const isGenericCrowdCharacter = (name: string | undefined) => {
  const value = String(name || '').trim()
  if (!value) return false
  if (['学生们', '同学们', '前排学生们', '后排学生们', '路人', '路人们', '人群', '群众', '围观者', '其他学生', '其他同学'].includes(value)) return true
  return /^(前排|后排|周围|旁边|附近)?(学生|同学|路人|群众|人群|观众|乘客|行人)们?$/.test(value)
}

export const api = {
  projects: () => get<Paged<Project>>('/studio/projects?page_size=100').then((d) => d.items),
  createProject: (body: { name: string; style: string; visual_style: string; default_video_ratio?: string; description?: string }) => {
    const id = 'proj_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)
    return post<Project>('/studio/projects', { id, description: '', ...body }).then(() => id)
  },
  deleteProject: (id: string) =>
    fetch(`${BASE}/studio/projects/${id}`, { method: 'DELETE' }).then((r) => {
      if (!r.ok) throw new Error(`删除失败 ${r.status}`)
    }),
  updateProject: (id: string, patch: Partial<Project>) =>
    fetch(`${BASE}/studio/projects/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).then((r) => {
      if (!r.ok) throw new Error(`更新失败 ${r.status}`)
    }),
  chapters: (projectId: string) =>
    get<Paged<Chapter>>(`/studio/chapters?project_id=${projectId}&page_size=100`).then((d) =>
      d.items.sort((a, b) => a.index - b.index),
    ),
  shots: (chapterId: string) =>
    get<Paged<Shot>>(`/studio/shots?chapter_id=${chapterId}&page_size=100`).then((d) =>
      d.items.sort((a, b) => a.index - b.index),
    ),
  // 镜头详情(景别/机位/运镜/时长)不在 shots 列表里，单独批量取，按 id 建映射
  // 后端无 project/chapter 过滤，只能翻页取全量（page_size=100，直到 max_page）
  async shotDetails(): Promise<Record<string, any>> {
    const m: Record<string, any> = {}
    for (let page = 1; ; page++) {
      const d = await get<Paged<any>>(`/studio/shot-details?page=${page}&page_size=100`)
      d.items.forEach((x) => (m[x.id] = x))
      if (page >= (d.pagination?.max_page ?? 1)) break
    }
    return m
  },
  // 单个镜头详情：含真实的关键帧提示词(frame-prompt 任务生成后落库)
  shotDetail: (shotId: string) => get<any>(`/studio/shot-details/${shotId}`).catch(() => null),
  // 整章镜头的角色关联（批量）：shot_id → character_id[]
  shotCharacters: (chapterId: string) =>
    get<{ shot_id: string; character_id: string }[]>(`/studio/shot-character-links?chapter_id=${chapterId}`).then((items) => {
      const m: Record<string, string[]> = {}
      items.forEach((x) => (m[x.shot_id] ||= []).push(x.character_id))
      return m
    }),
  updateShotDetail: (shotId: string, patch: Record<string, any>) =>
    fetch(`${BASE}/studio/shot-details/${shotId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).then((r) => { if (!r.ok) throw new Error(`保存失败 ${r.status}`) }),
  createChapter: (projectId: string, index: number, title: string, raw_text: string) =>
    post('/studio/chapters', {
      id: `${projectId}_ch${String(index).padStart(2, '0')}`, project_id: projectId, index, title, raw_text,
    }),
  updateChapter: (id: string, raw_text: string) =>
    fetch(`${BASE}/studio/chapters/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw_text }),
    }).then((r) => { if (!r.ok) throw new Error(`保存失败 ${r.status}`) }),
  entities: (type: string, projectId: string) =>
    get<Paged<Entity>>(`/studio/entities/${type}?project_id=${projectId}&page_size=100`).then((d) => d.items),
  updateEntity: (type: string, id: string, patch: Partial<Entity>) =>
    fetch(`${BASE}/studio/entities/${type}/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).then((r) => { if (!r.ok) throw new Error(`更新失败 ${r.status}`) }),

  // —— 画面生成链 ——
  frameImages: (shotId: string) =>
    get<Paged<FrameImage>>(`/studio/shot-frame-images?shot_detail_id=${shotId}&page_size=50`).then((d) => d.items),
  // 全量帧图索引（一次翻页拉齐）：shot_id → { frame_type: file_id }，做镜头列表缩略图
  async frameIndex(): Promise<Record<string, Partial<Record<FrameType, string>>>> {
    const m: Record<string, Partial<Record<FrameType, string>>> = {}
    for (let page = 1; ; page++) {
      const d = await get<Paged<FrameImage>>(`/studio/shot-frame-images?page=${page}&page_size=100`)
      d.items.forEach((im) => {
        if (!im.file_id) return
        ;(m[im.shot_detail_id] ||= {})[im.frame_type] = im.file_id
      })
      if (page >= (d.pagination?.max_page ?? 1)) break
    }
    return m
  },
  createFramePromptTask: (shotId: string, frameType: FrameType) =>
    post<{ task_id: string }>('/film/tasks/shot-frame-prompts', { shot_id: shotId, frame_type: frameType }).then((d) => d.task_id),
  renderFramePrompt: (shotId: string, frameType: FrameType, prompt: string, refs?: any[]) =>
    post<{ rendered_prompt: string; base_prompt: string; images: string[]; mappings: any[] }>(
      `/studio/image-tasks/shot/${shotId}/frame-render-prompt`,
      {
        frame_type: frameType,
        prompt,
        ...(refs?.length ? { images: refs.map((r) => ({ ...r, name: cleanRefName(r.name, `${r.type}:${r.id}`) })) } : {}),
      },
    ),
  // 镜头关联资产（角色/场景/道具）及各自最佳造型图 file_id——作帧生成参考图
  shotLinkedAssets: (shotId: string) =>
    get<Paged<{ type: string; id: string; image_id: number | null; file_id: string | null; name: string; thumbnail?: string }>>(
      `/studio/shots/${shotId}/linked-assets?page_size=50`,
    ).then((d) => d.items),
  // 取该镜头可用的参考图（角色优先→场景→道具，最多 6 张）：一致性的关键——
  // 有参考图时后端 OpenAI 通道自动走 /images/edits（图生图），脸/场景/道具都锚在造型图上。
  // 注意：bridge 拆镜只写 detail.scene_id 不建 scene/prop links，linked-assets 只有角色，
  // 场景从镜头详情补（同场景取最多 2 个不同角度），道具按名称命中动作/台词文本补。
  async frameRefs(shotId: string, projectId?: string) {
    const order: Record<string, number> = { character: 0, prop: 1, scene: 2 }
    const refs = (await api.shotLinkedAssets(shotId).catch(() => []))
      .filter((x) => x.file_id && x.type !== 'costume')
      .filter((x) => x.type !== 'character' || !isGenericCrowdCharacter(x.name))
    const detail = await api.shotDetail(shotId)
    let sceneName = ''

    // 道具：仅名称命中本镜动作/台词的才算必要（≤2）
    if (projectId && detail && !refs.some((r) => r.type === 'prop')) {
      const text = [...(detail.action_beats || []), detail.description || ''].join('')
      const props = await api.entities('prop', projectId).catch(() => [] as Entity[])
      for (const p of props.filter((x) => x.name && text.includes(x.name)).slice(0, 2)) {
        const im = (await api.entityImages('prop', p.id).catch(() => []))[0]
        if (im?.file_id) refs.push({ type: 'prop', id: p.id, name: im.name || p.name, image_id: im.id, file_id: im.file_id })
      }
    }

    // 场景：按景别给必要配额——特写背景虚化不给，中景 1 张，远景 2 张；纯环境空镜保底 1 张
    const cam = detail?.camera_shot || 'MS'
    let sceneQuota = ['ECU', 'CU'].includes(cam) ? 0 : ['MCU', 'MS'].includes(cam) ? 1 : 2
    if (!refs.length) sceneQuota = Math.max(sceneQuota, 1)
    if (detail?.scene_id && sceneQuota > 0 && !refs.some((r) => r.type === 'scene')) {
      if (projectId) {
        const scenes = await api.entities('scene', projectId).catch(() => [] as Entity[])
        sceneName = scenes.find((x) => x.id === detail.scene_id)?.name || ''
      }
      const imgs = (await api.entityImages('scene', detail.scene_id).catch(() => [])).filter((x: any) => x.file_id)
      // 近景优先细节角度，远景优先主视角+反打
      const pref = ['ECU', 'CU', 'MCU'].includes(cam) ? ['DETAIL', 'FRONT', 'BACK'] : ['FRONT', 'BACK', 'DETAIL']
      imgs.sort((a: any, b: any) => pref.indexOf(a.view_angle) - pref.indexOf(b.view_angle))
      imgs.slice(0, sceneQuota).forEach((im: any) =>
        refs.push({ type: 'scene', id: detail.scene_id, name: im.name || sceneName || '场景参考图', image_id: im.id, file_id: im.file_id }))
    }
    return refs
      .map((r) => ({ ...r, name: cleanRefName(r.name, `${r.type}:${r.id}`) }))
      .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))
      .slice(0, 6)
  },
  // 参考图关系由后端最终渲染器根据实际映射补齐，前端不拼固定模板话。
  refGuard(refs: { type: string }[]) {
    return ''
  },
  createFrameImageTask: (shotId: string, frameType: FrameType, prompt: string, targetRatio = '9:16', refs?: any[]) =>
    post<{ task_id: string }>(`/studio/image-tasks/shot/${shotId}/frame-image-tasks`, {
      frame_type: frameType,
      prompt,
      target_ratio: targetRatio,
      ...(refs?.length ? { images: refs.map((r) => ({ ...r, name: cleanRefName(r.name, `${r.type}:${r.id}`) })) } : {}),
    }).then((d) => d.task_id),
  createFrameImageBatch: (items: { shot_id: string; name?: string; frame_type?: FrameType; images?: any[] }[], targetRatio = '9:16') =>
    post<{ batch_id: string; total: number }>('/studio/image-tasks/frame-batches', {
      target_ratio: targetRatio,
      items: items.map((it) => ({
        ...it,
        frame_type: it.frame_type || 'key',
        images: (it.images || []).map((r) => ({ ...r, name: cleanRefName(r.name, `${r.type}:${r.id}`) })),
      })),
    }),
  frameImageBatchStatus: (batchId: string) =>
    get<AssetImageBatchStatus>(`/studio/image-tasks/frame-batches/${batchId}`),
  async pollFrameImageBatch(batchId: string, onProgress?: (s: AssetImageBatchStatus) => void, isCancelled?: () => boolean) {
    for (;;) {
      if (isCancelled?.()) return null
      const s = await api.frameImageBatchStatus(batchId)
      onProgress?.(s)
      if (s.status === 'succeeded' || s.status === 'failed' || s.status === 'cancelled') return s
      await sleep(2500)
    }
  },
  taskStatus: (taskId: string) => get<TaskStatus>(`/film/tasks/${taskId}/status`),
  taskResult: (taskId: string) => get<{ status: string; result: any; error: string }>(`/film/tasks/${taskId}/result`),

  // —— 造型图生成链（角色/演员/场景/道具/服装）——
  entityImages: (type: string, id: string) =>
    get<Paged<any>>(`/studio/entities/${type}/${id}/images?page_size=20`).then((d) => d.items),
  // 角色无自动图槽，先建一个 FRONT 槽；场景/道具/服装/演员创建时已有槽
  async ensureImageSlot(type: string, id: string): Promise<number> {
    const imgs = await api.entityImages(type, id)
    if (imgs[0]?.id != null) return imgs[0].id
    const r = await post<{ id: number }>(`/studio/entities/${type}/${id}/images`, { view_angle: 'FRONT', quality_level: 'LOW' })
    // 后端 commit-after-yield：槽刚建好立刻发图像任务会校验不到（"image_id does not belong"），
    // 轮询到新槽可读再返回
    for (let i = 0; i < 10; i++) {
      const again = await api.entityImages(type, id)
      if (again.some((x) => x.id === r.id)) break
      await sleep(700)
    }
    return r.id
  },
  // 生成造型图：建槽 → 投任务 → 轮询 → 返回 file_id
  async generateEntityImage(type: string, id: string, prompt: string, onProgress?: (p: number) => void, isCancelled?: () => boolean): Promise<string> {
    const imageId = await api.ensureImageSlot(type, id)
    const path =
      type === 'character' ? `/studio/image-tasks/characters/${id}/image-tasks`
      : type === 'actor' ? `/studio/image-tasks/actors/${id}/image-tasks`
      : `/studio/image-tasks/assets/${type}/${id}/image-tasks`
    const { task_id } = await post<{ task_id: string }>(path, { image_id: imageId, prompt })
    const s = await api.pollTask(task_id, onProgress, 120, isCancelled) // 图像任务上限 5 分钟（三视图大图常超 150s）
    if (s.status !== 'succeeded') {
      const r = await api.taskResult(task_id).catch(() => null)
      throw new Error(r?.error || `生成${s.status === 'cancelled' ? '已取消' : '失败'}`)
    }
    const imgs = await api.entityImages(type, id)
    const hit = imgs.find((x) => x.id === imageId) || imgs[0]
    if (!hit?.file_id) throw new Error('任务完成但未返回图片')
    return hit.file_id
  },
  createAssetImageBatch: (items: { type: string; id: string; name: string; image_id: number; prompt: string }[]) =>
    post<{ batch_id: string; total: number }>('/studio/image-tasks/asset-batches', { items }),
  assetImageBatchStatus: (batchId: string) =>
    get<AssetImageBatchStatus>(`/studio/image-tasks/asset-batches/${batchId}`),
  async pollAssetImageBatch(batchId: string, onProgress?: (s: AssetImageBatchStatus) => void, isCancelled?: () => boolean) {
    for (;;) {
      if (isCancelled?.()) return null
      const s = await api.assetImageBatchStatus(batchId)
      onProgress?.(s)
      if (s.status === 'succeeded' || s.status === 'failed' || s.status === 'cancelled') return s
      await sleep(2500)
    }
  },

  // —— pipeline 文本三步(视觉词典/镜头分镜/视听单元)，走 bridge/pipeline_server(:5280) ——
  // 服务没起时代理返回空/HTML，r.json() 会抛晦涩的 "Unexpected end of JSON input"，统一转成人话
  async _pipelineJson(url: string, init?: RequestInit): Promise<any> {
    let r: Response
    try {
      r = await fetch(url, init)
    } catch {
      throw new Error('pipeline 服务连不上（bridge/pipeline_server.py 未启动？端口 5280）')
    }
    try {
      return await r.json()
    } catch {
      throw new Error('pipeline 服务未启动（cd bridge && python pipeline_server.py）')
    }
  },
  runPipeline: (step: 'extract-setup' | 'visual-dict' | 'shot-breakdown' | 'unit-gen', pid: string) =>
    api._pipelineJson(`/pipeline/${step}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }),
    }).then((j) => {
      if (!j.job_id) throw new Error(j.error || 'pipeline 启动失败(服务未起?)')
      return j.job_id as string
    }),
  async pollPipeline(jobId: string, tries = 200, isCancelled?: () => boolean): Promise<{ status: string; log: string; error: string }> {
    for (let i = 0; i < tries; i++) {
      if (isCancelled?.()) return { status: 'cancelled', log: '', error: '' }
      const j = await api._pipelineJson(`/pipeline/jobs/${jobId}`)
      if (j.status === 'done') return j
      if (j.status === 'error') throw new Error(j.error || '生成失败')
      await sleep(3000)
    }
    throw new Error('pipeline 超时')
  },

  // 轮询任务直到 succeeded/failed（默认最多 ~120s）
  // 容忍瞬时网络错误：连续 3 次失败才放弃，单个 502 不应中断仍在跑的任务
  async pollTask(taskId: string, onProgress?: (p: number) => void, tries = 60, isCancelled?: () => boolean): Promise<TaskStatus> {
    let last: TaskStatus | null = null
    let errs = 0
    for (let i = 0; i < tries; i++) {
      if (isCancelled?.()) return last ?? { task_id: taskId, status: 'cancelled', progress: 0 }
      try {
        const s = await api.taskStatus(taskId)
        last = s
        errs = 0
        onProgress?.(s.progress)
        if (s.status === 'succeeded' || s.status === 'failed' || s.status === 'cancelled') return s
      } catch (e) {
        if (++errs >= 3) throw e
      }
      await sleep(2500)
    }
    throw new Error('任务超时')
  },
}
