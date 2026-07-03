import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Chapter, type Entity, type Project, type Shot } from '../lib/api'

const ACTS = ['建置', '对抗', '收束']

export default function Storyboard({ project }: { project: Project | null }) {
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [chapterId, setChapterId] = useState<string>('')
  const [shots, setShots] = useState<Shot[]>([])
  const [scenes, setScenes] = useState<Entity[]>([])
  const [chars, setChars] = useState<Entity[]>([])
  const [sel, setSel] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [pipe, setPipe] = useState('') // shot-breakdown / unit-gen 进行中
  const [batchP, setBatchP] = useState('') // 批量生成进度
  const navigate = useNavigate()

  const reloadShots = (cid = chapterId) => {
    if (!cid) return Promise.resolve()
    setLoading(true)
    return Promise.all([api.shots(cid), api.shotDetails().catch(() => ({}))])
      .then(([s, details]) => {
        const merged = s.map((x) => {
          const d = (details as Record<string, any>)[x.id]
          return d ? { ...x, camera_shot: d.camera_shot, duration: d.duration } : x
        })
        setShots(merged)
        setSel(merged[0]?.id ?? '')
      })
      .catch(() => setShots([]))
      .finally(() => setLoading(false))
  }

  // AI 拆镜头(镜头级分镜)
  async function aiBreakdown() {
    if (!project || pipe) return
    if (!confirm('AI 重新拆镜头会替换本集现有镜头，继续？')) return
    setPipe('shot')
    try {
      const j = await api.runPipeline('shot-breakdown', project.id)
      await api.pollPipeline(j)
      await reloadShots()
    } catch (e: any) { alert(e?.message || '拆镜头失败') } finally { setPipe('') }
  }
  // 生成视听单元(供图生视频)
  async function genUnits() {
    if (!project || pipe) return
    setPipe('unit')
    try {
      const j = await api.runPipeline('unit-gen', project.id)
      await api.pollPipeline(j)
      alert('视听单元已生成（bridge/units-*.json，供图生视频/图像 prompt）')
    } catch (e: any) { alert(e?.message || '视听单元生成失败') } finally { setPipe('') }
  }
  // 批量生成本集所有镜头的关键帧
  async function genAllFrames() {
    if (!shots.length || batchP) return
    const ratio = project?.default_video_ratio || '9:16'
    for (let i = 0; i < shots.length; i++) {
      setBatchP(`${i + 1}/${shots.length}`)
      const s = shots[i]
      try {
        let prompt = ''
        try {
          const pt = await api.createFramePromptTask(s.id, 'key')
          const ps = await api.pollTask(pt)
          if (ps.status === 'succeeded') prompt = ((await api.taskResult(pt)).result?.prompt || '').trim()
        } catch {}
        if (!prompt) prompt = [s.camera_shot, s.title, s.script_excerpt].filter(Boolean).join('，').slice(0, 300)
        const it = await api.createFrameImageTask(s.id, 'key', prompt, ratio)
        await api.pollTask(it)
      } catch {}
    }
    setBatchP('')
    await reloadShots()
  }

  useEffect(() => {
    if (!project) return
    api.chapters(project.id).then((cs) => {
      setChapters(cs)
      setChapterId(cs[0]?.id ?? '')
    })
    api.entities('scene', project.id).then(setScenes).catch(() => {})
    api.entities('character', project.id).then(setChars).catch(() => {})
  }, [project])

  useEffect(() => {
    reloadShots(chapterId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId])

  const n = Math.max(shots.length, 1)
  const grid = { gridTemplateColumns: `88px repeat(${n}, minmax(150px, 1fr))` }
  // 三幕切分：把镜头按序等分到 建置/对抗/收束
  const actSpans = useMemo(() => {
    const per = Math.max(1, Math.ceil(n / 3))
    return ACTS.map((label, i) => {
      const start = i * per + 1
      const end = Math.min(n, (i + 1) * per)
      return { label, from: start + 1, to: end + 2 } // grid line (1=label col)
    }).filter((a) => a.to > a.from)
  }, [n])

  if (!project) return <div className="center">未找到项目 · 请先用 bridge 导入剧本</div>

  return (
    <div className="work">
      <div className="work-head">
        <h1>分镜 · 时序</h1>
        <select className="ep-select" value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>第 {c.index} 集{c.title ? ` · ${c.title}` : ''}</option>
          ))}
        </select>
        <div className="spacer" />
        <button className="btn ghost" disabled={!!pipe || !!batchP} onClick={aiBreakdown}>
          {pipe === 'shot' ? '拆镜头中…' : 'AI 拆镜头'}
        </button>
        <button className="btn ghost" disabled={!!pipe || !!batchP} onClick={genUnits}>
          {pipe === 'unit' ? '生成中…' : '生成视听单元'}
        </button>
        <button className="btn primary" disabled={!!batchP || !!pipe || !shots.length} onClick={genAllFrames}>
          {batchP ? `生成本集画面 ${batchP}` : '生成本集画面'}
        </button>
      </div>

      {/* 本集场景/造型 上下文 */}
      <div className="sb-ctx">
        <span className="ctx-k">场景</span><span className="ctx-v">{scenes.map((s) => s.name).join(' · ') || '未设置'}</span>
        <span className="ctx-k">造型</span><span className="ctx-v">{chars.map((c) => c.name).join(' · ') || '—'}</span>
      </div>

      {loading ? (
        <div className="center" style={{ height: 200 }}>加载中…</div>
      ) : shots.length === 0 ? (
        <div className="center" style={{ height: 180 }}>本集尚无分镜 · 点「AI 拆镜头」按情节拆解</div>
      ) : (
        <div className="sb-list">
          <div className="sb-row sb-head">
            <div className="c-no">#</div>
            <div className="c-thumb">画面</div>
            <div className="c-cam">景别·时长</div>
            <div className="c-body">镜头内容</div>
            <div className="c-ready">就绪</div>
          </div>
          {shots.map((s) => {
            const ready = s.status === 'ready'
            return (
              <div
                className={'sb-row' + (s.id === sel ? ' sel' : '')}
                key={s.id}
                onClick={() => setSel(s.id)}
                onDoubleClick={() => navigate(`/frames?shot=${s.id}`)}
                title="双击进入画面工作台创作"
              >
                <div className="c-no">{String(s.index).padStart(2, '0')}</div>
                <div className="c-thumb"><div className={'th' + (ready ? ' done' : '')} /></div>
                <div className="c-cam">
                  <span className="tag">{s.camera_shot || 'MS'}</span>
                  {s.duration ? <span className="dur">{s.duration}s</span> : null}
                </div>
                <div className="c-body">
                  <div className="t">{s.title || `镜头 ${s.index}`}</div>
                  <div className="ex">{(s.script_excerpt || '').slice(0, 70) || '—'}</div>
                </div>
                <div className="c-ready">
                  <div className="pips">{[0, 1, 2].map((i) => <span key={i} className={'pip' + (ready ? ' on' : '')} />)}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="legend">
        <span>双击某镜头 → 画面工作台创作</span>
        <span>共 {shots.length} 个镜头</span>
        <span>时序自上而下</span>
      </div>
    </div>
  )
}
