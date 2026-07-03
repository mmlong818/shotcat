import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, fileUrl, type Chapter, type Entity, type FrameType, type Project, type Shot } from '../lib/api'
import Lightbox from '../Lightbox'

const FRAMES: { key: FrameType; label: string }[] = [
  { key: 'first', label: '首帧' },
  { key: 'key', label: '关键帧' },
  { key: 'last', label: '尾帧' },
]

type FrameState = { fileId: string | null; busy: boolean; stage: string; error: string }
const emptyFrame = (): FrameState => ({ fileId: null, busy: false, stage: '', error: '' })

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
  const [detail, setDetail] = useState<any>(null) // 镜头详情(含真实首/关/尾帧提示词)

  useEffect(() => {
    if (!project) return
    api.entities('character', project.id).then(setCast).catch(() => {})
    api.entities('scene', project.id).then(setScenes).catch(() => {})
    api.chapters(project.id).then((cs) => {
      setChapters(cs)
      const first = cs[0]
      if (first)
        Promise.all([api.shots(first.id), api.shotDetails().catch(() => ({}))]).then(([s, details]) => {
          const merged = s.map((x) => {
            const d = (details as Record<string, any>)[x.id]
            return d ? { ...x, camera_shot: d.camera_shot, duration: d.duration } : x
          })
          setShots(merged)
          const want = params.get('shot')
          setSel(merged.find((x) => x.id === want) ?? merged[0] ?? null)
        })
    })
  }, [project])

  // 选中镜头 → 载入已有帧图
  const loadFrames = useCallback((shotId: string) => {
    setFrames({ first: emptyFrame(), key: emptyFrame(), last: emptyFrame() })
    api.frameImages(shotId).then((imgs) => {
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
    if (sel) {
      loadFrames(sel.id)
      api.shotDetail(sel.id).then(setDetail)
    }
  }, [sel, loadFrames])

  const setFrame = (ft: FrameType, patch: Partial<FrameState>) =>
    setFrames((prev) => ({ ...prev, [ft]: { ...prev[ft], ...patch } }))

  async function generate(ft: FrameType) {
    if (!sel) return
    setFrame(ft, { busy: true, error: '', stage: '生成提示词…' })
    try {
      // 1) 基础提示词（失败/空则退回剧本摘录构造）
      let prompt = ''
      try {
        const ptask = await api.createFramePromptTask(sel.id, ft)
        const ps = await api.pollTask(ptask)
        if (ps.status === 'succeeded') {
          const r = await api.taskResult(ptask)
          prompt = (r.result?.prompt || '').trim()
        }
      } catch {
        /* 降级到摘录 */
      }
      if (!prompt) {
        prompt = [sel.camera_shot, sel.title, sel.script_excerpt].filter(Boolean).join('，').slice(0, 300)
      }
      if (!prompt) throw new Error('无可用提示词（该镜头缺少剧本摘录）')

      // 2) 生成图（target_ratio 必填；503=无图像模型 会在此同步抛出）
      setFrame(ft, { stage: '生成画面…' })
      const ratio = project?.default_video_ratio || '16:9'
      const itask = await api.createFrameImageTask(sel.id, ft, prompt, ratio)
      const is = await api.pollTask(itask, (p) => setFrame(ft, { stage: `生成画面… ${p}%` }))
      if (is.status !== 'succeeded') {
        const r = await api.taskResult(itask).catch(() => null)
        throw new Error(r?.error || `生成${is.status === 'cancelled' ? '已取消' : '失败'}`)
      }

      // 3) 取回图片（占位行 file_id 可能为 null → 视为失败）
      const imgs = await api.frameImages(sel.id)
      const hit = imgs.find((im) => im.frame_type === ft)
      if (!hit?.file_id) throw new Error('任务完成但未返回图片（模型未产出）')
      setFrame(ft, { busy: false, stage: '', fileId: hit.file_id })
      api.shotDetail(sel.id).then(setDetail) // 刷新真实帧提示词

    } catch (e: any) {
      setFrame(ft, { busy: false, stage: '', error: e?.message || '生成失败' })
    }
  }

  async function generateAll() {
    for (const f of FRAMES) await generate(f.key)
  }

  if (!project) return <div className="center">未找到项目 · 请先用 bridge 导入剧本</div>
  const anyBusy = Object.values(frames).some((f) => f.busy)

  const readyCount = (['first', 'key', 'last'] as FrameType[]).filter((t) => frames[t].fileId).length

  return (
      <div className="work">
        <div className="work-head">
          <h1>画面工作台</h1>
          <div className="spacer" />
          <button className="btn ghost" disabled={anyBusy || !sel} onClick={generateAll}>批量生成</button>
          <button className="btn primary" disabled={anyBusy || !sel} onClick={() => generate('key')}>生成本镜关键帧</button>
        </div>

        <div className="canvas">
          <div className="fstrip">
            <div className="lbl">镜头 · {shots.length}</div>
            {shots.map((s) => (
              <div key={s.id} className={'fshot' + (sel?.id === s.id ? ' sel' : '')} onClick={() => setSel(s)}>
                <div className={'th' + (s.status === 'ready' ? ' done' : '')} />
                <div className="m">
                  <div className="t">{s.title || `镜头 ${s.index}`}</div>
                  <div className="s">{String(s.index).padStart(2, '0')}{s.camera_shot ? ` · ${s.camera_shot}` : ''}</div>
                </div>
              </div>
            ))}
          </div>

          <div>
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
              <span className="ready-badge">画面就绪 {readyCount} / 3 帧</span>
            </div>

            <div className="frames">
              {FRAMES.map((f) => {
                const st = frames[f.key]
                return (
                  <div key={f.key} className={'frame' + (st.fileId ? ' filled' : '')}>
                    <div className="img">
                      {st.fileId ? (
                        <img className="zoomable" src={fileUrl(st.fileId)} alt={f.label} title="点击放大"
                          onClick={() => setLb(fileUrl(st.fileId!))}
                          style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      ) : st.busy ? (
                        <div className="ph"><div className="plus">◔</div>{st.stage}</div>
                      ) : st.error ? (
                        <div className="ph" style={{ color: 'var(--danger)' }} title={st.error}>⚠ {st.error.slice(0, 24)}</div>
                      ) : (
                        <div className="ph"><div className="plus">＋</div>生成{f.label}</div>
                      )}
                    </div>
                    <div className="cap">
                      <span className="k">{f.label}</span>
                      {st.fileId ? (
                        <span className="tag" style={{ cursor: 'pointer' }} onClick={() => generate(f.key)}>重生成</span>
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

            <div className="prompt">
              <div className="ph"><span className="k">画面提示词（真实生成用，含锁定造型/场景/景别机位/连续性）</span></div>
              {(() => {
                const map: [FrameType, string][] = [
                  ['first', detail?.first_frame_prompt], ['key', detail?.key_frame_prompt], ['last', detail?.last_frame_prompt],
                ].filter(([, v]) => v && String(v).trim()) as [FrameType, string][]
                const labels: Record<FrameType, string> = { first: '首帧', key: '关键帧', last: '尾帧' }
                if (map.length === 0)
                  return (
                    <div className="box muted">
                      尚未生成 · 点某帧「生成」后，会用 frame-prompt 结合本镜头**关联角色的锁定造型 + 场景 + 景别机位 + 前后连续性**自动产出完整提示词并显示于此。
                      <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 12 }}>
                        预览依据：{sel?.camera_shot || 'MS'} · {sel?.title} — {(sel?.script_excerpt || '').slice(0, 40)}
                      </div>
                    </div>
                  )
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {map.map(([ft, v]) => (
                      <div className="box" key={ft}>
                        <span className="em">【{labels[ft]}】</span>{v}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>

            {/* 生成依据：角色/场景 参考，横向并入中间 */}
            <div className="refs-row">
              <div className="refs-group">
                <div className="rg-h">角色设计 · 生成依据</div>
                <div className="rg-list">
                  {cast.length === 0 && <div className="muted" style={{ fontSize: 12 }}>暂无角色 · 先在造型页设置</div>}
                  {cast.map((c) => (
                    <div className="ref-ent" key={c.id}>
                      <div className="rthumb" />
                      <div className="ri"><div className="rn">{c.name}</div><div className="rd">{c.description || '未填写外貌'}</div></div>
                      <span className="rid">{c.id}</span>
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
                      <div className="rthumb scene" />
                      <div className="ri"><div className="rn">{s.name}</div><div className="rd">{s.description || '未填写场景描述'}</div></div>
                      <span className="rid">{s.id}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
        <Lightbox url={lb} onClose={() => setLb(null)} />
      </div>
  )
}
