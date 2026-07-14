import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, fileUrl, type Chapter, type Entity, type FrameType, type Project, type Shot } from '../lib/api'
import Lightbox from '../Lightbox'

const FRAMES: { key: FrameType; label: string }[] = [
  { key: 'key', label: '关键帧' },
]

type FrameState = { fileId: string | null; busy: boolean; stage: string; error: string }
const emptyFrame = (): FrameState => ({ fileId: null, busy: false, stage: '', error: '' })

const stripReferenceLines = (text: string) =>
  String(text || '')
    .split('\n')
    .filter((line) => !/^(角色参考|场景参考|道具参考|参考)：/.test(line.trim()))
    .join('\n')
    .trim()

export default function Frames({ project }: { project: Project | null }) {
  const [params] = useSearchParams()
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [shots, setShots] = useState<Shot[]>([])
  const [sel, setSel] = useState<Shot | null>(null)
  const [frames, setFrames] = useState<Record<FrameType, FrameState>>({
    first: emptyFrame(), key: emptyFrame(), last: emptyFrame(),
  })
  const [cast, setCast] = useState<Entity[]>([])
  const [scenes, setScenes] = useState<Entity[]>([])
  const [lb, setLb] = useState<string | null>(null)
  const [detail, setDetail] = useState<any>(null) // 镜头详情(含真实关键帧提示词)
  const [renderedPrompts, setRenderedPrompts] = useState<Partial<Record<FrameType, string>>>({})
  const [promptDrafts, setPromptDrafts] = useState<Partial<Record<FrameType, string>>>({})
  const [openCh, setOpenCh] = useState<Record<string, boolean>>({}) // 镜头列表按集折叠
  const [thumbs, setThumbs] = useState<Record<string, Partial<Record<FrameType, string>>>>({}) // 镜头缩略图索引
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [exporting, setExporting] = useState(false)

  // 当前选中镜头 id 的实时引用：异步链回写前用它校验镜头未被切走
  const selRef = useRef<string | null>(null)
  useEffect(() => { selRef.current = sel?.id ?? null }, [sel])
  // 用户手动改过的提示词不能再被异步参考图渲染结果覆盖。
  const promptEditedRef = useRef<Partial<Record<FrameType, boolean>>>({})
  // 卸载时置位，正在轮询的任务据此停止
  // 挂载时重置：StrictMode(dev) 模拟卸载会把 ref 置 true 且跨挂载保留，不重置则轮询秒取消
  const cancelledRef = useRef(false)
  useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true } }, [])

  useEffect(() => {
    if (!project) return
    api.entities('character', project.id).then(setCast).catch(() => {})
    api.entities('scene', project.id).then(setScenes).catch(() => {})
    api.frameIndex().then(setThumbs).catch(() => {})
    api.chapters(project.id).then((cs) => {
      setChapters(cs)
      if (!cs.length) return
      // 载入全部章节的镜头（深链 ?shot= 可能指向第 2 集及以后的镜头）
      Promise.all([
        Promise.all(cs.map((c) => api.shots(c.id).catch(() => []))),
        api.shotDetails().catch(() => ({})),
      ]).then(([perCh, details]) => {
        const merged = perCh.flat().map((x) => {
          const d = (details as Record<string, any>)[x.id]
          return d ? { ...x, camera_shot: d.camera_shot, duration: d.duration } : x
        })
        setShots(merged)
        const want = params.get('shot')
        const target = merged.find((x) => x.id === want) ?? merged[0] ?? null
        setSel(target)
        // 默认只展开选中镜头所在的集；已手动开合过的保持原状
        const focusCh = target?.chapter_id ?? cs[0].id
        setOpenCh((o) => {
          const n = { ...o }
          cs.forEach((c) => { if (n[c.id] === undefined) n[c.id] = c.id === focusCh })
          if (want && target) n[focusCh] = true // 深链指定的镜头一定展开可见
          return n
        })
      })
    }).catch(() => {})
  }, [project?.id, params])

  // 选中镜头 → 载入已有帧图
  const loadFrames = useCallback((shotId: string) => {
    setFrames({ first: emptyFrame(), key: emptyFrame(), last: emptyFrame() })
    api.frameImages(shotId).then((imgs) => {
      if (selRef.current !== shotId) return // 已切换镜头，丢弃过期响应
      setFrames((prev) => {
        const next = { ...prev }
        for (const im of imgs) {
          if (im.frame_type in next) next[im.frame_type] = { ...emptyFrame(), fileId: im.file_id }
        }
        return next
      })
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!sel) return
    const shotId = sel.id
    setRenderedPrompts({})
    setPromptDrafts({})
    promptEditedRef.current = {}
    loadFrames(shotId)
    api.shotDetail(shotId).then((d) => { if (selRef.current === shotId) setDetail(d) })
  }, [sel, loadFrames])

  useEffect(() => {
    if (!sel || !detail) return
    const shotId = sel.id
    let cancelled = false
    const bases: [FrameType, string][] = [
      ['key', detail.key_frame_prompt],
    ].filter(([, v]) => v && String(v).trim()) as [FrameType, string][]
    if (!bases.length) return
    ;(async () => {
      const refs = await api.frameRefs(shotId, project?.id).catch(() => [])
      const next: Partial<Record<FrameType, string>> = {}
      for (const [ft, base] of bases) {
        const finalBase = stripReferenceLines(String(base).trim()) + api.refGuard(refs)
        const rendered = await api.renderFramePrompt(shotId, ft, finalBase, refs).catch(() => null)
        next[ft] = (rendered?.rendered_prompt || finalBase).trim()
      }
      if (!cancelled && selRef.current === shotId) {
        setRenderedPrompts(next)
        setPromptDrafts((drafts) => {
          const updated = { ...drafts }
          for (const [frameType, prompt] of Object.entries(next) as [FrameType, string][]) {
            if (!promptEditedRef.current[frameType]) updated[frameType] = prompt
          }
          return updated
        })
      }
    })()
    return () => { cancelled = true }
  }, [detail, project?.id, sel])

  const setFrame = (ft: FrameType, patch: Partial<FrameState>) =>
    setFrames((prev) => ({ ...prev, [ft]: { ...prev[ft], ...patch } }))

  async function generate(ft: FrameType) {
    if (!sel) return
    if (frames[ft].busy) return // 该帧正在生成，防重入
    const shotId = sel.id
    const shot = sel
    const manualPrompt = stripReferenceLines(promptDrafts[ft] || '')
    const alive = () => selRef.current === shotId // 镜头未被切走才回写 UI
    const cancelled = () => cancelledRef.current
    setFrame(ft, { busy: true, error: '', stage: '生成提示词…' })
    try {
      // 1) 基础提示词（失败/空则退回剧本摘录构造）
      let prompt = manualPrompt
      if (!prompt) {
        try {
          const ptask = await api.createFramePromptTask(shotId, ft)
          const ps = await api.pollTask(ptask, undefined, 60, cancelled)
          if (ps.status === 'succeeded') {
            const r = await api.taskResult(ptask)
            prompt = (r.result?.prompt || '').trim()
          }
        } catch {
          /* 降级到摘录 */
        }
      }
      if (!prompt) {
        prompt = [shot.camera_shot, shot.title, shot.script_excerpt].filter(Boolean).join('，').slice(0, 300)
      }
      if (!prompt) throw new Error('无可用提示词（该镜头缺少剧本摘录）')

      // 2) 生成图（target_ratio 必填；503=无图像模型 会在此同步抛出）
      // 带上镜头关联的造型图作参考图（角色→场景→道具）——跨镜一致性的关键
      const refs = await api.frameRefs(shotId, project?.id)
      const finalBasePrompt = stripReferenceLines(prompt) + api.refGuard(refs)
      const rendered = manualPrompt ? null : await api.renderFramePrompt(shotId, ft, finalBasePrompt, refs).catch(() => null)
      const finalPrompt = (rendered?.rendered_prompt || finalBasePrompt).trim()
      if (alive()) setRenderedPrompts((m) => ({ ...m, [ft]: finalPrompt }))
      if (alive()) setPromptDrafts((m) => ({ ...m, [ft]: finalPrompt }))
      if (alive()) setFrame(ft, { stage: refs.length ? `生成画面…（${refs.length} 张参考图）` : '生成画面…' })
      const ratio = project?.default_video_ratio || '9:16'
      const itask = await api.createFrameImageTask(shotId, ft, finalPrompt, ratio, refs)
      const is = await api.pollTask(itask, (p) => { if (alive()) setFrame(ft, { stage: `生成画面… ${p}%` }) }, 120, cancelled)
      if (is.status !== 'succeeded') {
        const r = await api.taskResult(itask).catch(() => null)
        throw new Error(r?.error || `生成${is.status === 'cancelled' ? '已取消' : '失败'}`)
      }

      // 3) 取回图片（占位行 file_id 可能为 null → 视为失败）
      const imgs = await api.frameImages(shotId)
      const hit = imgs.find((im) => im.frame_type === ft)
      if (!hit?.file_id) throw new Error('任务完成但未返回图片（模型未产出）')
      // 缩略图按镜头 id 记录，与当前选中无关，切走了也更新
      setThumbs((m) => ({ ...m, [shotId]: { ...m[shotId], [ft]: hit.file_id! } }))
      // 镜头已切走：结果已落库，下次选回该镜头 loadFrames 会取到；此处不再回写 UI
      if (!alive()) return
      setFrame(ft, { busy: false, stage: '', fileId: hit.file_id })
      api.shotDetail(shotId).then((d) => { if (selRef.current === shotId) setDetail(d) }) // 刷新真实帧提示词

    } catch (e: any) {
      if (alive()) setFrame(ft, { busy: false, stage: '', error: e?.message || '生成失败' })
    }
  }

  async function generateBatchFrames() {
    if (!project || batch || !shots.length) return
    const ft: FrameType = 'key'
    const ratio = project.default_video_ratio || '9:16'
    const idx = await api.frameIndex().catch(() => thumbs)
    const queue = shots.filter((shot) => {
      const f = idx[shot.id]
      return !f?.key
    })
    if (!queue.length) {
      alert('当前列表没有缺失画面的镜头')
      return
    }
    setBatch({ done: 0, total: queue.length })
    try {
      const items = await Promise.all(queue.map(async (shot) => {
        const refs = await api.frameRefs(shot.id, project.id).catch(() => [])
        return { shot_id: shot.id, name: shot.title || `镜头 ${shot.index}`, frame_type: ft, images: refs }
      }))
      const created = await api.createFrameImageBatch(items, ratio)
      await api.pollFrameImageBatch(created.batch_id, (s) => {
        setBatch({ done: s.succeeded + s.failed, total: s.total })
      })
    } finally {
      setBatch(null)
      api.frameIndex().then(setThumbs).catch(() => {})
      if (selRef.current) loadFrames(selRef.current)
    }
  }

  async function exportKeyframes() {
    if (!project || exporting) return
    setExporting(true)
    try {
      const response = await api.exportProjectKeyframes(project.id)
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.message || `导出失败 ${response.status}`)
      }
      const contentDisposition = response.headers.get('Content-Disposition') || ''
      const encodedName = /filename\*=UTF-8''([^;]+)/.exec(contentDisposition)?.[1]
      const filename = encodedName ? decodeURIComponent(encodedName) : `${project.name || '项目'}_关键帧.zip`
      const blobUrl = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(blobUrl)
    } catch (error: any) {
      alert(error?.message || '导出关键帧失败')
    } finally {
      setExporting(false)
    }
  }

  if (!project) return <div className="center">未找到项目 · 请先用 bridge 导入剧本</div>
  const anyBusy = Object.values(frames).some((f) => f.busy) || !!batch

  const readyCount = frames.key.fileId ? 1 : 0

  return (
      <div className="work frames-page">
        <div className="work-head">
          <h1>画面工作台</h1>
        <div className="spacer" />
          <button className="btn ghost" disabled={exporting || !project} onClick={exportKeyframes}>
            {exporting ? '打包导出中…' : '批量导出关键帧'}
          </button>
          <button className="btn ghost" disabled={anyBusy || !shots.length} onClick={generateBatchFrames}>
            {batch ? `批量投任务 ${batch.done}/${batch.total}` : '批量生成缺失画面'}
          </button>
          <button className="btn primary" disabled={anyBusy || !sel} onClick={() => generate('key')}>生成本镜关键帧</button>
        </div>

        <div className="canvas">
          <div className="fstrip">
            <div className="lbl">镜头 · {shots.length}</div>
            {chapters.map((c) => {
              const list = shots.filter((s) => s.chapter_id === c.id)
              if (!list.length) return null
              return (
                <div className="fs-grp" key={c.id}>
                  <div className="fs-ch" onClick={() => setOpenCh((o) => ({ ...o, [c.id]: !o[c.id] }))}>
                    <span className="ep-caret">{openCh[c.id] ? '▾' : '▸'}</span>
                    <span className="t">第 {c.index} 集</span>
                    <span className="n">{list.length}</span>
                  </div>
                  {openCh[c.id] && list.map((s) => {
                    const t = thumbs[s.id]
                    const tf = t?.key
                    return (
                      <div key={s.id} className={'fshot' + (sel?.id === s.id ? ' sel' : '')} onClick={() => setSel(s)}>
                        {tf ? (
                          <img className="th" src={fileUrl(tf)} alt="" loading="lazy" />
                        ) : (
                          <div className={'th' + (s.status === 'ready' ? ' done' : '')} />
                        )}
                        <div className="m">
                          <div className="t">{s.title || `镜头 ${s.index}`}</div>
                          <div className="s">{String(s.index).padStart(2, '0')}{s.camera_shot ? ` · ${s.camera_shot}` : ''}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>

          <div className="stage-col">
            <div className="stage-title">
              <div className="h">
                镜头 {sel?.index ?? '—'} · {sel?.title || '未选择'}
                <span>{(sel?.script_excerpt || '').slice(0, 30)}</span>
              </div>
            </div>

            {/* 镜头属性 + 就绪度：并入中间的紧凑信息条 */}
            <div className="meta-bar">
              <span className="mi"><b>序号</b>{sel ? String(sel.index).padStart(2, '0') : '—'}</span>
              <span className="mi"><b>景别</b>{sel?.camera_shot || '—'}</span>
              <span className="mi"><b>时长</b>{sel?.duration ? `${sel.duration}s` : '—'}</span>
              <span className="mi"><b>状态</b>{sel?.status === 'ready' ? '就绪' : '待确认'}</span>
              <span className="spacer" />
              <span className="ready-badge">关键帧 {readyCount} / 1</span>
            </div>

            <div className="frame-workspace">
              <div className="frame-main">
                <div className="frames">
                  {FRAMES.map((f) => {
                    const st = frames[f.key]
                    return (
                      <div key={f.key} className={'frame' + (st.fileId ? ' filled' : '')}>
                        <div className="img">
                          {st.busy ? (
                            <div className="ph"><div className="plus">◔</div>{st.stage}</div>
                          ) : st.fileId ? (
                            <img className="zoomable" src={fileUrl(st.fileId)} alt={f.label} title="点击放大"
                              onClick={() => setLb(fileUrl(st.fileId!))}
                              style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                          ) : st.error ? (
                            <div className="ph" style={{ color: 'var(--danger)' }} title={st.error}>⚠ {st.error.slice(0, 24)}</div>
                          ) : (
                            <div className="ph"><div className="plus">＋</div>生成{f.label}</div>
                          )}
                        </div>
                        <div className="cap">
                          <span className="k">{f.label}</span>
                          {st.fileId ? (
                            <span className="tag" style={{ cursor: st.busy ? 'default' : 'pointer', opacity: st.busy ? 0.5 : 1 }}
                              onClick={st.busy ? undefined : () => generate(f.key)}>
                              {st.busy ? '生成中' : '重生成'}
                            </span>
                          ) : (
                            <button className="btn ghost" style={{ padding: '2px 9px', fontSize: 11 }} disabled={st.busy || !sel} onClick={() => generate(f.key)}>
                              {st.busy ? '生成中' : '生成'}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* 生成依据：角色/场景 参考，横向并入中间 */}
                <div className="refs-row">
                  <div className="refs-group">
                    <div className="rg-h">角色设计 · 生成依据</div>
                    <div className="rg-list">
                      {cast.length === 0 && <div className="muted" style={{ fontSize: 12 }}>暂无角色 · 先在造型页设置</div>}
                      {cast.map((c) => (
                        <div className="ref-ent" key={c.id}>
                          {c.thumbnail ? (
                            <img src={c.thumbnail} alt={c.name} title="点击放大" onClick={() => setLb(c.thumbnail!)} />
                          ) : (
                            <div className="ref-empty">未生成</div>
                          )}
                          <div className="rn">{c.name}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="refs-group">
                    <div className="rg-h">场景设计 · 生成依据</div>
                    <div className="rg-list">
                      {scenes.length === 0 && <div className="muted" style={{ fontSize: 12 }}>暂无场景 · 先在造型页设置</div>}
                      {scenes.map((s) => (
                        <div className="ref-ent" key={s.id}>
                          {s.thumbnail ? (
                            <img src={s.thumbnail} alt={s.name} title="点击放大" onClick={() => setLb(s.thumbnail!)} />
                          ) : (
                            <div className="ref-empty">未生成</div>
                          )}
                          <div className="rn">{s.name}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <aside className="prompt prompt-side">
                <div className="ph"><span className="k">画面提示词</span></div>
                {(() => {
                  const map: [FrameType, string][] = [
                    ['key', promptDrafts.key ?? renderedPrompts.key ?? detail?.key_frame_prompt ?? ''],
                  ]
                  const labels: Partial<Record<FrameType, string>> = { key: '关键帧' }
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {map.map(([ft, v]) => (
                        <div className="box" key={ft}>
                          <div className="prompt-row-head">
                            <span className="em">【{labels[ft]}】</span>
                            <button
                              className="btn ghost"
                              style={{ padding: '2px 9px', fontSize: 11 }}
                              disabled={!sel || frames[ft].busy}
                              onClick={() => generate(ft)}
                            >
                              {frames[ft].fileId ? '用此提示词重生成' : '用此提示词生成'}
                            </button>
                          </div>
                          <textarea
                            className="prompt-edit"
                            value={promptDrafts[ft] ?? v}
                            placeholder="输入关键帧画面提示词"
                            onChange={(e) => {
                              promptEditedRef.current[ft] = true
                              setPromptDrafts((m) => ({ ...m, [ft]: e.target.value }))
                            }}
                            onBlur={(e) => {
                              if (!sel) return
                              const value = e.target.value
                              api.updateShotDetail(sel.id, { key_frame_prompt: value })
                                .then(() => setDetail((d: any) => ({ ...d, key_frame_prompt: value })))
                                .catch((err) => alert(err?.message || '保存提示词失败'))
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </aside>
            </div>
          </div>
        </div>
        <Lightbox url={lb} onClose={() => setLb(null)} />
      </div>
  )
}
