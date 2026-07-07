import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ANGLE_ZH, CAMERA_ZH, MOVE_ZH, type Chapter, type Entity, type Project, type Shot } from '../lib/api'

// 对白判别：新数据 bridge 会给对白包「」；旧数据是 [动作, 对白] 双拍点，第二条即对白
const isDialogue = (b: string, idx: number, total: number) => /[「『“"]/.test(b) || (total === 2 && idx === 1)

// 场次时间/内外景存在 mood_tags 里（约定 "时:日" / "景:内"，与 bridge 同构）
const TIMES = ['日', '夜', '晨', '黄昏']
const SPACES = ['内', '外']
const tagOf = (s: Shot, prefix: string) =>
  (s.mood_tags || []).find((t) => t.startsWith(prefix))?.slice(prefix.length) || ''
const withTag = (s: Shot, prefix: string, val: string) => [
  ...(s.mood_tags || []).filter((t) => !t.startsWith(prefix)),
  ...(val ? [`${prefix}${val}`] : []),
]

// 对白字数（去引号/标点/空白）与朗读秒数换算：常规每秒 4 字，慢速每秒 3 字
const PUNCT = /[「」『』“”\s，。！？；：、…—·,.!?;:]/g
const dlgChars = (beats: string[]) =>
  beats.reduce((n, b, j) => n + (isDialogue(b, j, beats.length) ? b.replace(PUNCT, '').length : 0), 0)
const speakSecs = (chars: number) => ({ normal: Math.ceil(chars / 4), slow: Math.ceil(chars / 3) })

export default function Storyboard({ project }: { project: Project | null }) {
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [shotsByCh, setShotsByCh] = useState<Record<string, Shot[]>>({})
  const [castByShot, setCastByShot] = useState<Record<string, string[]>>({}) // shot_id → character_id[]
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [scenes, setScenes] = useState<Entity[]>([])
  const [chars, setChars] = useState<Entity[]>([])
  const [sel, setSel] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [pipe, setPipe] = useState('') // shot-breakdown / unit-gen 进行中
  const [batch, setBatch] = useState<{ cid: string; p: string } | null>(null) // 单集批量生成进度
  const [err, setErr] = useState('')
  const navigate = useNavigate()

  const reqRef = useRef(0) // 加载请求令牌：仅最新请求可回写，避免切项目竞态
  const cancelledRef = useRef(false) // 卸载后停止轮询
  // 挂载时重置：StrictMode(dev) 模拟卸载会把 ref 置 true 且跨挂载保留，不重置则轮询秒取消
  useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true } }, [])

  const loadAll = async () => {
    if (!project) return
    const token = ++reqRef.current
    setLoading(true); setErr('')
    try {
      const cs = await api.chapters(project.id)
      const [perCh, details, perChCast] = await Promise.all([
        Promise.all(cs.map((c) => api.shots(c.id).catch(() => [] as Shot[]))),
        api.shotDetails().catch(() => ({})),
        Promise.all(cs.map((c) => api.shotCharacters(c.id).catch(() => ({} as Record<string, string[]>)))),
      ])
      if (token !== reqRef.current) return
      setCastByShot(Object.assign({}, ...perChCast))
      setChapters(cs)
      const m: Record<string, Shot[]> = {}
      cs.forEach((c, i) => {
        m[c.id] = perCh[i].map((x) => {
          const d = (details as Record<string, any>)[x.id]
          return d ? {
            ...x, camera_shot: d.camera_shot, duration: d.duration,
            angle: d.angle, movement: d.movement, action_beats: d.action_beats, description: d.description,
            scene_id: d.scene_id, mood_tags: d.mood_tags,
          } : x
        })
      })
      setShotsByCh(m)
      // 默认只展开第一集；已手动开合过的保持原状
      setOpen((o) => {
        const n = { ...o }
        cs.forEach((c, i) => { if (n[c.id] === undefined) n[c.id] = i === 0 })
        return n
      })
    } catch {
      if (token === reqRef.current) setErr('分镜加载失败')
    } finally {
      if (token === reqRef.current) setLoading(false)
    }
  }

  // AI 拆镜头(镜头级分镜)
  async function aiBreakdown() {
    if (!project || pipe) return
    if (!confirm('AI 重新拆镜头会替换现有镜头，继续？')) return
    setPipe('shot')
    try {
      const j = await api.runPipeline('shot-breakdown', project.id)
      await api.pollPipeline(j, 200, () => cancelledRef.current)
      await loadAll()
    } catch (e: any) { alert(e?.message || '拆镜头失败') } finally { setPipe('') }
  }
  // 生成视听单元(供图生视频)
  async function genUnits() {
    if (!project || pipe) return
    setPipe('unit')
    try {
      const j = await api.runPipeline('unit-gen', project.id)
      await api.pollPipeline(j, 200, () => cancelledRef.current)
      alert('视听单元已生成（bridge/units-*.json，供图生视频/图像 prompt）')
    } catch (e: any) { alert(e?.message || '视听单元生成失败') } finally { setPipe('') }
  }
  // 批量生成某一集所有镜头的关键帧
  async function genAllFrames(cid: string) {
    const list = shotsByCh[cid] || []
    if (!list.length || batch) return
    const ratio = project?.default_video_ratio || '9:16'
    const cancelled = () => cancelledRef.current
    for (let i = 0; i < list.length; i++) {
      if (cancelled()) break // 页面已卸载，不再投新任务
      setBatch({ cid, p: `${i + 1}/${list.length}` })
      const s = list[i]
      try {
        let prompt = ''
        try {
          const pt = await api.createFramePromptTask(s.id, 'key')
          const ps = await api.pollTask(pt, undefined, 60, cancelled)
          if (ps.status === 'succeeded') prompt = ((await api.taskResult(pt)).result?.prompt || '').trim()
        } catch {}
        if (!prompt) prompt = [s.camera_shot, s.title, s.script_excerpt].filter(Boolean).join('，').slice(0, 300)
        const refs = await api.frameRefs(s.id, project?.id) // 角色/场景/道具造型图作参考
        const it = await api.createFrameImageTask(s.id, 'key', prompt + api.refGuard(refs), ratio, refs)
        await api.pollTask(it, undefined, 120, cancelled)
      } catch {}
    }
    setBatch(null)
    if (!cancelled()) await loadAll()
  }

  useEffect(() => {
    if (!project) return
    loadAll()
    api.entities('scene', project.id).then(setScenes).catch(() => {})
    api.entities('character', project.id).then(setChars).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  if (!project) return <div className="center">未找到项目 · 请先用 bridge 导入剧本</div>

  const totalShots = Object.values(shotsByCh).reduce((n, l) => n + l.length, 0)
  const sceneName = (id?: string | null) => (id ? scenes.find((s) => s.id === id)?.name : undefined)
  const charName = (id: string) => chars.find((c) => c.id === id)?.name || id.split('__').pop()

  // 行内编辑：本地乐观更新 + PATCH，失败回读
  const patchLocal = (cid: string, shotId: string, patch: Partial<Shot>) =>
    setShotsByCh((m) => ({ ...m, [cid]: (m[cid] || []).map((x) => (x.id === shotId ? { ...x, ...patch } : x)) }))
  const saveDetail = (cid: string, shotId: string, patch: Record<string, any>) => {
    patchLocal(cid, shotId, patch)
    api.updateShotDetail(shotId, patch).catch((e) => { alert(e?.message || '保存失败'); loadAll() })
  }

  return (
    <div className="work">
      <div className="work-head">
        <h1>分镜 · 时序</h1>
        <div className="spacer" />
        <button className="btn ghost" disabled={!!pipe || !!batch} onClick={aiBreakdown}>
          {pipe === 'shot' ? '拆镜头中…' : 'AI 拆镜头'}
        </button>
        <button className="btn ghost" disabled={!!pipe || !!batch} onClick={genUnits}>
          {pipe === 'unit' ? '生成中…' : '生成视听单元'}
        </button>
      </div>

      {/* 场景/造型 上下文 */}
      <div className="sb-ctx">
        <span className="ctx-k">场景</span><span className="ctx-v">{scenes.map((s) => s.name).join(' · ') || '未设置'}</span>
        <span className="ctx-k">造型</span><span className="ctx-v">{chars.map((c) => c.name).join(' · ') || '—'}</span>
      </div>

      {err && <div className="fld-err" style={{ marginBottom: 12 }}>{err}</div>}

      {loading ? (
        <div className="center" style={{ height: 200 }}>加载中…</div>
      ) : chapters.length === 0 ? (
        <div className="center" style={{ height: 180 }}>尚无剧本 · 先去「剧本」页粘贴正文</div>
      ) : (
        chapters.map((c) => {
          const list = shotsByCh[c.id] || []
          const secs = list.reduce((n, s) => n + (s.duration || 0), 0)
          return (
            <div className="ep-block" key={c.id}>
              <div className="ep-h fold" onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}>
                <span className="ep-caret">{open[c.id] ? '▾' : '▸'}</span>
                <span className="ep-t">第 {c.index} 集{c.title ? ` · ${c.title}` : ''}</span>
                <span className="ep-cnt">{list.length} 个镜头{secs > 0 && ` · 总时长约 ${secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`}`}</span>
                <button className="btn ghost" disabled={!!batch || !!pipe || !list.length}
                  onClick={(e) => { e.stopPropagation(); genAllFrames(c.id) }}>
                  {batch?.cid === c.id ? `生成画面 ${batch.p}` : '生成本集画面'}
                </button>
              </div>
              {open[c.id] && (list.length === 0 ? (
                <div className="center" style={{ height: 90 }}>本集尚无分镜 · 点「AI 拆镜头」按情节拆解</div>
              ) : (
                <div className="sb-list">
                  <div className="sb-row sb-cols">
                    <div className="c-no">#</div>
                    <div>镜头</div>
                    <div>场景</div>
                    <div>角色</div>
                    <div>画面</div>
                    <div>台词</div>
                  </div>
                  {list.map((s) => {
                    const ready = s.status === 'ready'
                    const beats = s.action_beats || []
                    const editing = s.id === sel // 选中行进入行内编辑
                    const castNames = (castByShot[s.id] || []).map(charName).filter(Boolean)
                    const dc = dlgChars(beats)
                    const need = speakSecs(dc)
                    const tight = dc > 0 && (s.duration || 0) < need.normal // 常规语速都说不完
                    // 动作/台词分栏（专业分镜表双栏）；台词编辑时去外层引号，保存时补回
                    const stripQ = (x: string) => x.replace(/^「|」$/g, '')
                    const wrapQ = (x: string) => (/[「『“"]/.test(x) ? x : `「${x}」`)
                    const actBeats = beats.filter((b, j) => !isDialogue(b, j, beats.length))
                    const dlgBeats = beats.filter((b, j) => isDialogue(b, j, beats.length))
                    const commitBeats = () => {
                      const cur = s.action_beats || []
                      const a = cur.filter((b, j) => !isDialogue(b, j, cur.length)).map((x) => x.trim()).filter(Boolean)
                      const d = cur.filter((b, j) => isDialogue(b, j, cur.length)).map(stripQ).map((x) => x.trim()).filter(Boolean).map((x) => `「${x}」`)
                      saveDetail(c.id, s.id, { action_beats: [...a, ...d] })
                    }
                    return (
                      <div
                        className={'sb-row' + (editing ? ' sel' : '')}
                        key={s.id}
                        onClick={() => setSel(s.id)}
                        onDoubleClick={() => navigate(`/frames?shot=${s.id}`)}
                        title={editing ? undefined : '单击编辑 · 双击进画面工作台'}
                      >
                        <div className="c-no">{String(s.index).padStart(2, '0')}{ready && <div className="okdot" title="画面就绪">✓</div>}</div>
                        {editing ? (
                          <div className="c-cam" onClick={(e) => e.stopPropagation()}>
                            <select className="cam-sel" value={s.camera_shot || 'MS'}
                              onChange={(e) => saveDetail(c.id, s.id, { camera_shot: e.target.value })}>
                              {Object.entries(CAMERA_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                            <select className="cam-sel" value={s.angle || 'EYE_LEVEL'}
                              onChange={(e) => saveDetail(c.id, s.id, { angle: e.target.value })}>
                              {Object.entries(ANGLE_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                            <select className="cam-sel" value={s.movement || 'STATIC'}
                              onChange={(e) => saveDetail(c.id, s.id, { movement: e.target.value })}>
                              {Object.entries(MOVE_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                            <span className={'dur-edit' + (tight ? ' warn' : '')}>
                              <input className="dur-in" type="number" min={1} max={60} value={s.duration || 5}
                                onChange={(e) => patchLocal(c.id, s.id, { duration: Number(e.target.value) })}
                                onBlur={(e) => saveDetail(c.id, s.id, { duration: Math.max(1, Math.min(60, Number(e.target.value) || 5)) })} />s
                            </span>
                          </div>
                        ) : (
                          <div className="c-cam">
                            <span className="tag">{CAMERA_ZH[s.camera_shot || ''] || s.camera_shot || '中景'}</span>
                            {s.angle && <span className="tag sub">{ANGLE_ZH[s.angle] || s.angle}</span>}
                            {s.movement && <span className="tag sub">{MOVE_ZH[s.movement] || s.movement}</span>}
                            {s.duration ? <span className={'dur' + (tight ? ' warn' : '')}>{s.duration}s{tight && ' ⚠'}</span> : null}
                          </div>
                        )}
                        {/* 场景列：场景名 + 内外/时间（场次头三要素）；编辑态均可改 */}
                        <div className="c-scn">
                          {editing ? (
                            <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <select className="cam-sel" value={s.scene_id || ''}
                                onChange={(e) => saveDetail(c.id, s.id, { scene_id: e.target.value || null })}>
                                <option value="">（未绑定）</option>
                                {scenes.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
                              </select>
                              <div style={{ display: 'flex', gap: 4 }}>
                                <select className="cam-sel" value={tagOf(s, '景:')}
                                  onChange={(e) => saveDetail(c.id, s.id, { mood_tags: withTag(s, '景:', e.target.value) })}>
                                  <option value="">内/外</option>
                                  {SPACES.map((v) => <option key={v} value={v}>{v}景</option>)}
                                </select>
                                <select className="cam-sel" value={tagOf(s, '时:')}
                                  onChange={(e) => saveDetail(c.id, s.id, { mood_tags: withTag(s, '时:', e.target.value) })}>
                                  <option value="">时间</option>
                                  {TIMES.map((v) => <option key={v} value={v}>{v}</option>)}
                                </select>
                              </div>
                            </div>
                          ) : (
                            <>
                              {sceneName(s.scene_id) || <span className="none">—</span>}
                              {(tagOf(s, '景:') || tagOf(s, '时:')) && (
                                <div className="scn-sub">
                                  {[tagOf(s, '景:') && `${tagOf(s, '景:')}景`, tagOf(s, '时:')].filter(Boolean).join(' · ')}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                        {/* 角色列 */}
                        <div className="c-who">
                          {castNames.length > 0 ? castNames.map((n, j) => <div key={j}>{n}</div>) : <span className="none">—</span>}
                        </div>
                        <button className="btn ghost go" onClick={(e) => { e.stopPropagation(); navigate(`/frames?shot=${s.id}`) }}>
                          画面 →
                        </button>
                        <div className="c-act">
                          {editing ? (
                            <textarea
                              className="beat-in"
                              value={actBeats.join('\n')}
                              placeholder="动作/画面描述，一行一个拍点…"
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => patchLocal(c.id, s.id, {
                                action_beats: [...e.target.value.split('\n'), ...dlgBeats.map(wrapQ)],
                              })}
                              onBlur={commitBeats}
                            />
                          ) : actBeats.length > 0 ? (
                            actBeats.map((b, j) => <div className="act" key={j}>{b}</div>)
                          ) : (
                            <div className="act">{s.script_excerpt || s.title || '—'}</div>
                          )}
                        </div>
                        <div className="c-dlg">
                          {editing ? (
                            <textarea
                              className="beat-in dlg"
                              value={dlgBeats.map(stripQ).join('\n')}
                              placeholder="台词，一行一句…"
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => patchLocal(c.id, s.id, {
                                action_beats: [...actBeats, ...e.target.value.split('\n').map(wrapQ)],
                              })}
                              onBlur={commitBeats}
                            />
                          ) : (
                            dlgBeats.map((b, j) => <div className="dlg" key={j}>{wrapQ(b)}</div>)
                          )}
                          {tight && (
                            <div className="dlg-time warn">
                              对白 {dc} 字，当前 {s.duration}s 说不完（常规语速需 ≥ {need.normal}s）
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )
        })
      )}

      <div className="legend">
        <span>双击某镜头 → 画面工作台创作</span>
        <span>共 {totalShots} 个镜头</span>
        <span>时序自上而下</span>
      </div>
    </div>
  )
}
