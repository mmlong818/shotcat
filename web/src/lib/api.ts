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
export interface Shot { id: string; index: number; title?: string; status?: string; script_excerpt?: string; camera_shot?: string; duration?: number }
export interface Entity { id: string; name: string; description?: string; thumbnail?: string; costume_id?: string }
export interface FrameImage { id: number; shot_detail_id: string; frame_type: 'first' | 'key' | 'last'; file_id: string | null }
export interface TaskStatus { task_id: string; status: string; progress: number }
export type FrameType = 'first' | 'key' | 'last'

interface Paged<T> { items: T[]; pagination: { total: number } }

export const fileUrl = (fileId: string) => `${BASE}/studio/files/${fileId}/download`

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

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
  shotDetails: () =>
    get<Paged<any>>('/studio/shot-details?page_size=100').then((d) => {
      const m: Record<string, any> = {}
      d.items.forEach((x) => (m[x.id] = x))
      return m
    }),
  // 单个镜头详情：含真实的首/关/尾帧提示词(frame-prompt 任务生成后落库)
  shotDetail: (shotId: string) => get<any>(`/studio/shot-details/${shotId}`).catch(() => null),
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

  // —— 画面生成链 ——
  frameImages: (shotId: string) =>
    get<Paged<FrameImage>>(`/studio/shot-frame-images?shot_detail_id=${shotId}&page_size=50`).then((d) => d.items),
  createFramePromptTask: (shotId: string, frameType: FrameType) =>
    post<{ task_id: string }>('/film/tasks/shot-frame-prompts', { shot_id: shotId, frame_type: frameType }).then((d) => d.task_id),
  createFrameImageTask: (shotId: string, frameType: FrameType, prompt: string, targetRatio = '16:9') =>
    post<{ task_id: string }>(`/studio/image-tasks/shot/${shotId}/frame-image-tasks`, {
      frame_type: frameType,
      prompt,
      target_ratio: targetRatio,
    }).then((d) => d.task_id),
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
    return r.id
  },
  // 生成造型图：建槽 → 投任务 → 轮询 → 返回 file_id
  async generateEntityImage(type: string, id: string, prompt: string, onProgress?: (p: number) => void): Promise<string> {
    const imageId = await api.ensureImageSlot(type, id)
    const path =
      type === 'character' ? `/studio/image-tasks/characters/${id}/image-tasks`
      : type === 'actor' ? `/studio/image-tasks/actors/${id}/image-tasks`
      : `/studio/image-tasks/assets/${type}/${id}/image-tasks`
    const { task_id } = await post<{ task_id: string }>(path, { image_id: imageId, prompt })
    const s = await api.pollTask(task_id, onProgress)
    if (s.status !== 'succeeded') {
      const r = await api.taskResult(task_id).catch(() => null)
      throw new Error(r?.error || `生成${s.status === 'cancelled' ? '已取消' : '失败'}`)
    }
    const imgs = await api.entityImages(type, id)
    const hit = imgs.find((x) => x.id === imageId) || imgs[0]
    if (!hit?.file_id) throw new Error('任务完成但未返回图片')
    return hit.file_id
  },

  // —— pipeline 文本三步(视觉词典/镜头分镜/视听单元)，走 bridge/pipeline_server(:5280) ——
  runPipeline: (step: 'extract-setup' | 'visual-dict' | 'shot-breakdown' | 'unit-gen', pid: string) =>
    fetch(`/pipeline/${step}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }),
    }).then((r) => r.json()).then((j) => {
      if (!j.job_id) throw new Error(j.error || 'pipeline 启动失败(服务未起?)')
      return j.job_id as string
    }),
  async pollPipeline(jobId: string, tries = 200): Promise<{ status: string; log: string; error: string }> {
    for (let i = 0; i < tries; i++) {
      const j = await fetch(`/pipeline/jobs/${jobId}`).then((r) => r.json())
      if (j.status === 'done') return j
      if (j.status === 'error') throw new Error(j.error || '生成失败')
      await sleep(3000)
    }
    throw new Error('pipeline 超时')
  },

  // 轮询任务直到 succeeded/failed（默认最多 ~120s）
  async pollTask(taskId: string, onProgress?: (p: number) => void, tries = 60): Promise<TaskStatus> {
    for (let i = 0; i < tries; i++) {
      const s = await api.taskStatus(taskId)
      onProgress?.(s.progress)
      if (s.status === 'succeeded' || s.status === 'failed' || s.status === 'cancelled') return s
      await sleep(2500)
    }
    throw new Error('任务超时')
  },
}
