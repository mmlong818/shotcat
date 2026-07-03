import { useEffect, useMemo, useState } from 'react'
import { api, fileUrl, type Entity, type Project } from '../lib/api'
import Lightbox from '../Lightbox'

const CATS = [
  { key: 'character', label: '角色' },
  { key: 'actor', label: '演员' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '道具' },
  { key: 'costume', label: '服装' },
]

export default function Cast({ project }: { project: Project | null }) {
  const [data, setData] = useState<Record<string, Entity[]>>({})
  const [tab, setTab] = useState('character')
  const [fresh, setFresh] = useState<Record<string, string>>({}) // 刚生成的 file_id
  const [busy, setBusy] = useState<string>('') // 正在生成的实体 id
  const [stage, setStage] = useState('')
  const [err, setErr] = useState('')
  const [batch, setBatch] = useState(false)
  const [pipe, setPipe] = useState('') // 视觉词典生成中
  const [lb, setLb] = useState<string | null>(null)

  const loadAll = () => {
    if (!project) return
    Promise.all(CATS.map((c) => api.entities(c.key, project.id).catch(() => [] as Entity[]))).then((lists) => {
      const map: Record<string, Entity[]> = {}
      CATS.forEach((c, i) => (map[c.key] = lists[i]))
      setData(map)
    })
  }
  useEffect(loadAll, [project])

  const items = data[tab] ?? []
  const roleLabel = useMemo(() => CATS.find((c) => c.key === tab)?.label ?? '', [tab])
  const thumbOf = (e: Entity) => (fresh[e.id] ? fileUrl(fresh[e.id]) : e.thumbnail || '')
  const visualDesc = (e: Entity | null) => (e?.description || '').split('【表演基线】')[0].trim()

  const styleClause =
    project?.visual_style === '动漫'
      ? '【统一风格】统一动画/动漫渲染，一致的线条与上色、统一角色比例；'
      : '【统一风格】写实真人电影质感，实拍摄影、自然光影、统一中性影调，无插画/3D-CG感；'
  const DESIGN_PREFIX: Record<string, string> = {
    character: '角色三视图设定稿(character turnaround)：同一角色的【正面、侧面、背面】全身三视图，横向并排、统一比例站姿，纯净中性背景，均匀光照，清晰展示外貌/发型/服装细节，非叙事镜头。角色：',
    actor: '演员形象设定图，半身或全身，纯净中性背景，清晰展示五官与形象细节，设定集风格。主体：',
    scene: '场景设计图/概念设定图，横向广角，完整呈现空间整体形态、结构与布局，清晰交代关键陈设与材质细节，均匀光，非叙事分镜。空间：',
    prop: '道具设计图，纯净中性背景，主体居中，完整清晰展示道具的整体形态、材质与特定细节(刻痕/锈迹/文字等)，产品/设定集视角。道具：',
    costume: '服装设计图，人台或平铺展示，纯净背景，完整呈现服装款式、版型、材质与细节，设定集视角。服装：',
  }
  const designPrompt = (type: string, e: Entity) => {
    let body = visualDesc(e) || e.name
    if (type === 'character' && e.costume_id) {
      const cos = (data['costume'] ?? []).find((c) => c.id === e.costume_id)
      if (cos?.description) body += `。身着服装：${visualDesc(cos)}`
    }
    return styleClause + (DESIGN_PREFIX[type] || '') + body
  }

  async function gen(e: Entity) {
    if (busy) return
    setBusy(e.id); setErr(''); setStage('生成中…')
    try {
      const fid = await api.generateEntityImage(tab, e.id, designPrompt(tab, e), (p) => setStage(`生成中… ${p}%`))
      setFresh((m) => ({ ...m, [e.id]: fid }))
    } catch (x: any) {
      setErr(`${e.name}：${x?.message || '生成失败'}`)
    } finally {
      setBusy(''); setStage('')
    }
  }
  async function genMissing() {
    setBatch(true); setErr('')
    for (const e of items) { if (!thumbOf(e)) await gen(e) }
    setBatch(false)
  }
  async function lockVisualDict() {
    if (!project || pipe) return
    setPipe('dict'); setErr('')
    try {
      const job = await api.runPipeline('visual-dict', project.id)
      await api.pollPipeline(job)
      loadAll()
    } catch (x: any) { setErr(x?.message || '视觉词典生成失败') } finally { setPipe('') }
  }

  if (!project) return <div className="center">未找到项目 · 请先用 bridge 导入剧本</div>

  return (
    <div className="work">
      <div className="work-head">
        <h1>造型</h1>
        <div className="spacer" />
        <button className="btn ghost" disabled={!!pipe || !!busy} onClick={lockVisualDict}>
          {pipe === 'dict' ? '锁定中…（读全剧本）' : '① 锁定视觉词典'}
        </button>
        <button className="btn primary" disabled={batch || !!busy || !!pipe || items.length === 0} onClick={genMissing}>
          {batch ? '批量生成中…' : '② 生成缺失造型图'}
        </button>
      </div>

      <div className="tabs">
        {CATS.map((c) => (
          <button key={c.key} className={'tab' + (c.key === tab ? ' on' : '')} onClick={() => { setTab(c.key); setErr('') }}>
            {c.label} <span className="cnt">{(data[c.key] ?? []).length}</span>
          </button>
        ))}
      </div>

      {err && <div className="fld-err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="cast-grid">
        {items.map((e) => {
          const url = thumbOf(e)
          const busyThis = busy === e.id
          return (
            <div className="cast-card" key={e.id}>
              <div className="cc-img">
                {url ? (
                  <img className="zoomable" src={url} alt={e.name} title="点击放大" onClick={() => setLb(url)} />
                ) : busyThis ? (
                  <div className="cc-ph"><div className="plus">◔</div>{stage}</div>
                ) : (
                  <div className="cc-ph"><span>○ 未生成</span></div>
                )}
              </div>
              <div className="cc-body">
                <div className="cc-h">
                  <span className="n">{e.name}</span>
                  <span className="role">{roleLabel}</span>
                  <span className="id">{e.id.slice(-10)}</span>
                </div>
                <div className="cc-desc">{visualDesc(e) || '（未锁定，先跑「① 锁定视觉词典」）'}</div>
                <button className="btn primary" style={{ width: '100%' }} disabled={!!busy || batch} onClick={() => gen(e)}>
                  {busyThis ? (stage || '生成中…') : url ? '重新生成造型图' : '生成造型图'}
                </button>
              </div>
            </div>
          )
        })}
        {items.length === 0 && <div className="muted" style={{ padding: 20 }}>该分类暂无资产</div>}
      </div>

      <Lightbox url={lb} onClose={() => setLb(null)} />
    </div>
  )
}
