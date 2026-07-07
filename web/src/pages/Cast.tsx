import { useEffect, useMemo, useRef, useState } from 'react'
import { api, fileUrl, type Entity, type Project } from '../lib/api'
import Lightbox from '../Lightbox'

const CATS = [
  { key: 'character', label: '角色' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '道具' },
  { key: 'costume', label: '服装' },
]

const DEFAULT_ART_DIRECTION =
  '艺术指导：所有画面必须服务当前剧情和人物关系，保持同一部影片的摄影风格、年代质感、色彩基调与材质语言；角色图必须符合角色年龄、气质、服装和身份，场景图必须符合剧情发生地点的空间逻辑，道具和服装不得脱离角色与时代背景。电影感写实，统一中性影调，自然光影，细节清晰，设定集质感。'
const PROMPT_TEMPLATE_VERSION = 'scene-detailed-v1'
const SCENE_NEGATIVE_GUARD =
  '空场景，无人物、无人体、无脸、无手、无背影、无剪影、无人群、无动物、无叙事事件。'
const CLOTHING_RE = /(衣|服|上衣|下装|裤|裙|外套|衬衫|T恤|针织|毛衣|风衣|夹克|校服|制服|鞋|靴|帽|围巾|领口|袖|腰带|包|配饰|颜色|浅色|深色|白色|黑色|蓝色|灰色|棕色|米色|长裤|长裙|短裙)/
const NON_CLOTHING_RE = /(手拿|拿着|握着|捧着|背着|抱着|携带|旧笔记本|笔记本|书本|汽水|道具)/

function cleanCostumeText(value: string) {
  const parts = value
    .split(/[，,。；;、]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => CLOTHING_RE.test(part) && !NON_CLOTHING_RE.test(part))
  return parts.join('，')
}

function sceneDetailFromName(name: string) {
  const n = name.trim()
  const time =
    n.includes('清晨') ? '清晨柔和低角度日光穿过树冠，地面有淡淡露水反光，空气清透安静。'
    : n.includes('黄昏') ? '黄昏金色斜阳拉长建筑和树影，亮部温暖、阴影偏冷，空气里有细小尘埃感。'
    : n.includes('夜') || n.includes('期末') ? '夜晚室内日光灯偏冷，窗外环境压暗，桌面和墙面形成清晰明暗层次。'
    : '自然日光均匀照亮空间，保留真实校园环境的明暗层次和轻微空气透视。'

  const age =
    n.includes('旧') || n.includes('多年后') ? '墙面和地面有轻微褪色、磨损、旧标语残痕和被时间打磨的边角。'
    : n.includes('毕业') ? '保留毕业季的固定布置痕迹，例如操场主席台、横幅挂点、公告栏和整理过的队列区域。'
    : '整体带有普通校园的年代痕迹，材质不过度崭新，保留真实使用过的磨损和生活细节。'

  if (n.includes('校门')) {
    return `空无一人的${n}，正面广角呈现校园入口、门柱、校名牌、伸缩门或铁门轨道、门卫室、公告栏和两侧围墙。地面有车辙与落叶，门口道路向校内延伸，远处可见教学楼轮廓和树荫。${time}${age}`
  }
  if (n.includes('操场')) {
    return `空无一人的${n}，横向广角呈现塑胶跑道、白色跑道线、内场草坪或水泥球场、看台边缘、旗杆、远处教学楼和围栏。跑道线有轻微磨损，地面局部反光，边缘有树影和固定体育器材。${time}${age}`
  }
  if (n.includes('走廊') || n.includes('栏杆')) {
    return `空无一人的${n}，一侧是连续教室门窗和斑驳墙面，另一侧是栏杆、立柱和通向远处的透视线。地面瓷砖或水泥地有擦痕与反光，墙上有班级牌、公告栏、消防箱、旧灯管和窗框阴影。${time}${age}`
  }
  if (n.includes('教室')) {
    return `空无一人的${n}，横向广角呈现成排课桌椅、黑板、讲台、粉笔槽、窗帘、窗边光斑和墙面公告栏。桌面有细微划痕、书本压痕和粉笔灰，黑板边缘有擦拭残留，窗外透入校园树影。${time}${age}`
  }
  if (n.includes('小卖部')) {
    return `空无一人的${n}，横向广角呈现售卖窗口、遮阳棚、玻璃柜台、饮料冰柜、货架、价格牌、墙面瓷砖和门口台阶。柜台边缘有使用磨损，地面有细小水渍和旧海报痕迹，空间带校园生活气息。${time}${age}`
  }
  if (n.includes('教学楼')) {
    return `空无一人的${n}，横向广角呈现教学楼立面、入口台阶、走廊连廊、窗格、公告栏、树木和前方硬质铺地。建筑外墙有年代感纹理，窗框和栏杆带轻微锈蚀或褪色，空间秩序清晰。${time}${age}`
  }
  if (n.includes('校园')) {
    return `空无一人的${n}，横向广角呈现教学楼、操场边界、树木、旗杆、道路、公告栏和校园标识，空间层次从前景道路延伸到远处建筑。树叶投下细碎光斑，地面有落叶、白线和轻微磨损。${time}${age}`
  }
  return `空无一人的${n}，横向广角呈现地点的入口、主要动线、固定建筑结构、地面、墙面、门窗、标识、陈设和材质纹理。画面要清楚交代空间尺度、前中后景层次、可供后续镜头复用的环境锚点。${time}${age}`
}

export default function Cast({ project }: { project: Project | null }) {
  const [data, setData] = useState<Record<string, Entity[]>>({})
  const [tab, setTab] = useState('character')
  const [fresh, setFresh] = useState<Record<string, string>>({}) // 刚生成的 file_id
  const [busy, setBusy] = useState<string>('') // 正在生成的实体 id
  const [stage, setStage] = useState('')
  const [err, setErr] = useState('')
  const [batch, setBatch] = useState(false)
  const [pipe, setPipe] = useState('') // 视觉词典生成中
  const [angles, setAngles] = useState<Record<string, { id: number; file_id: string; view_angle: string }[]>>({}) // 实体全部角度图
  const [lb, setLb] = useState<string | null>(null)
  const [artDirection, setArtDirection] = useState(DEFAULT_ART_DIRECTION)
  const [promptEdits, setPromptEdits] = useState<Record<string, string>>({})
  const [promptResetTick, setPromptResetTick] = useState(0)
  const cancelledRef = useRef(false) // 卸载后停止轮询/批量
  // 挂载时必须重置：React 18 StrictMode(dev) 会模拟卸载再挂载，ref 跨挂载保留，
  // 不重置的话所有轮询一进来就"已取消"（任务照发、前端秒放弃）
  useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true } }, [])

  const loadAll = () => {
    if (!project) return
    Promise.all(CATS.map((c) => api.entities(c.key, project.id).catch(() => [] as Entity[]))).then((lists) => {
      const map: Record<string, Entity[]> = {}
      CATS.forEach((c, i) => (map[c.key] = lists[i]))
      setData(map)
    })
  }
  useEffect(loadAll, [project])
  useEffect(() => {
    if (!project) return
    const saved = localStorage.getItem(`shotcat:artDirection:${project.id}`)
    setArtDirection(saved || DEFAULT_ART_DIRECTION)
    const versionKey = `shotcat:promptTemplateVersion:${project.id}`
    const editsKey = `shotcat:promptEdits:${project.id}`
    const savedVersion = localStorage.getItem(versionKey)
    if (savedVersion !== PROMPT_TEMPLATE_VERSION) {
      localStorage.removeItem(editsKey)
      localStorage.setItem(versionKey, PROMPT_TEMPLATE_VERSION)
      setPromptEdits({})
      return
    }
    const savedPrompts = localStorage.getItem(editsKey)
    setPromptEdits(savedPrompts ? JSON.parse(savedPrompts) : {})
  }, [project?.id])

  useEffect(() => {
    if (!project) return
    localStorage.setItem(`shotcat:artDirection:${project.id}`, artDirection)
  }, [project?.id, artDirection])

  useEffect(() => {
    if (!project) return
    localStorage.setItem(`shotcat:promptEdits:${project.id}`, JSON.stringify(promptEdits))
  }, [project?.id, promptEdits])

  const items = data[tab] ?? []

  // 当前 tab 实体的全部角度图（BACK/DETAIL 等多角度参考也要能看到）
  useEffect(() => {
    let stale = false
    ;(async () => {
      const m: Record<string, { id: number; file_id: string; view_angle: string }[]> = {}
      for (const e of items) {
        const imgs = await api.entityImages(tab, e.id).catch(() => [])
        m[e.id] = imgs.filter((x: any) => x.file_id)
      }
      if (!stale) setAngles(m)
    })()
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, data])
  const roleLabel = useMemo(() => CATS.find((c) => c.key === tab)?.label ?? '', [tab])
  const thumbOf = (e: Entity) => (fresh[e.id] ? fileUrl(fresh[e.id]) : e.thumbnail || '')
  const visualDesc = (e: Entity | null) => (e?.description || '').split('【表演基线】')[0].trim()

  const styleClause = () => {
    const direction = artDirection.trim()
    if (direction) return `【艺术指导】${direction}；`
    return project?.visual_style === '动漫'
      ? '【风格】统一动画/动漫渲染，一致的线条与上色、统一角色比例；'
      : '【风格】写实真人电影质感，实拍摄影、自然光影、统一中性影调，无插画/3D-CG感；'
  }
  const DESIGN_PREFIX: Record<string, string> = {
    character: '角色三视图设定稿，正面/侧面/背面，纯净中性背景，清晰展示外貌、发型和服装。角色：',
    actor: '演员形象设定图，半身或全身，纯净中性背景，清晰展示五官与形象细节，设定集风格。主体：',
    scene: '横向广角场景概念设计图，作为后续镜头的环境参考图。画面主体：',
    prop: '道具设计图，纯净中性背景，主体居中，完整清晰展示道具的整体形态、材质与特定细节(刻痕/锈迹/文字等)，产品/设定集视角。道具：',
    costume: '服装设计图，人台或平铺展示，纯净背景，完整呈现服装款式、版型、材质与细节，设定集视角。服装：',
  }
  const designPrompt = (type: string, e: Entity) => {
    let body = type === 'scene'
      ? sceneDetailFromName(e.name)
      : visualDesc(e) || e.name
    if (type === 'character' && e.costume_id) {
      const cos = (data['costume'] ?? []).find((c) => c.id === e.costume_id)
      const costume = cos?.description ? cleanCostumeText(visualDesc(cos)) : ''
      if (costume) body += `。身着服装：${costume}`
    }
    const cleanSceneGuard = type === 'scene' ? `${SCENE_NEGATIVE_GUARD}` : ''
    if (type === 'scene') {
      return [(DESIGN_PREFIX[type] || '') + body, styleClause(), cleanSceneGuard].filter(Boolean).join(' ')
    }
    return styleClause() + (DESIGN_PREFIX[type] || '') + body
  }
  const promptKey = (type: string, id: string) => (
    type === 'scene' ? `${type}:${PROMPT_TEMPLATE_VERSION}:${id}` : `${type}:${id}`
  )
  const promptFor = (type: string, e: Entity) => {
    const saved = promptEdits[promptKey(type, e.id)]
    return saved ?? designPrompt(type, e)
  }
  const setPromptFor = (type: string, e: Entity, value: string) => {
    setPromptEdits((m) => ({ ...m, [promptKey(type, e.id)]: value }))
  }
  const clearSavedPrompts = () => {
    if (!project) return
    Object.keys(localStorage)
      .filter((key) => key.startsWith('shotcat:promptEdits:'))
      .forEach((key) => localStorage.removeItem(key))
    localStorage.setItem(`shotcat:promptTemplateVersion:${project.id}`, PROMPT_TEMPLATE_VERSION)
    setPromptEdits({})
    setPromptResetTick((v) => v + 1)
    setErr('已清除旧提示词，并按最新干净模板重建。')
  }
  const ensureSceneGuard = (prompt: string) => (
    prompt.includes(SCENE_NEGATIVE_GUARD) ? prompt : `${prompt} ${SCENE_NEGATIVE_GUARD}`
  )

  async function gen(e: Entity) {
    if (busy) return
    setBusy(e.id); setErr(''); setStage('生成中…')
    try {
      const prompt = (tab === 'scene' ? ensureSceneGuard(promptFor(tab, e)) : promptFor(tab, e)).trim()
      if (!prompt) throw new Error('提示词为空，请先填写后再生成')
      const fid = await api.generateEntityImage(tab, e.id, prompt, (p) => setStage(`生成中… ${p}%`), () => cancelledRef.current)
      setFresh((m) => ({ ...m, [e.id]: fid }))
    } catch (x: any) {
      setErr(`${e.name}：${x?.message || '生成失败'}`)
    } finally {
      setBusy(''); setStage('')
    }
  }
  async function genMissing() {
    setBatch(true); setErr('')
    for (const e of items) { if (cancelledRef.current) break; if (!thumbOf(e)) await gen(e) }
    setBatch(false)
  }
  async function lockVisualDict() {
    if (!project || pipe) return
    setPipe('dict'); setErr('')
    try {
      const job = await api.runPipeline('visual-dict', project.id)
      await api.pollPipeline(job, 200, () => cancelledRef.current)
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

      <div className="tone-panel">
        <div className="tone-head">
          <div>
            <div className="tone-title">艺术指导</div>
            <div className="tone-sub">统筹所有设定图：剧情、风格、角色特征、场景逻辑和时代质感都先在这里定准。</div>
          </div>
          <button className="btn ghost" onClick={clearSavedPrompts} disabled={!!busy || batch}>清除旧提示词</button>
          <button className="btn ghost" onClick={() => setArtDirection(DEFAULT_ART_DIRECTION)} disabled={!!busy || batch}>恢复默认</button>
        </div>
        <textarea
          className="prompt-edit tone-input"
          value={artDirection}
          disabled={!!busy || batch}
          onChange={(ev) => setArtDirection(ev.target.value)}
          placeholder="例如：青春校园回忆，清晨与黄昏偏暖，现实段更安静克制；所有角色服装符合年代，场景保持同一所学校的建筑体系。"
        />
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
              {(angles[e.id]?.length ?? 0) > 1 && (
                <div className="cc-angles">
                  {angles[e.id].map((im) => (
                    <img key={im.id} src={fileUrl(im.file_id)} alt={im.view_angle} title={`${im.view_angle} · 点击放大`}
                      onClick={() => setLb(fileUrl(im.file_id))} />
                  ))}
                </div>
              )}
              <div className="cc-body">
                <div className="cc-h">
                  <span className="n">{e.name}</span>
                  <span className="role">{roleLabel}</span>
                  <span className="id">{e.id.split('__').pop()}</span>
                </div>
                <div className="cc-desc">{visualDesc(e) || '（未锁定，先跑「① 锁定视觉词典」）'}</div>
                <div className="cc-prompt">
                  <div className="prompt-label">生成提示词{tab === 'scene' ? ` · ${PROMPT_TEMPLATE_VERSION}` : ''}</div>
                  <textarea
                    key={`${promptResetTick}:${tab}:${e.id}`}
                    className="prompt-edit"
                    value={promptFor(tab, e)}
                    disabled={busyThis || batch}
                    onChange={(ev) => setPromptFor(tab, e, ev.target.value)}
                  />
                  <div className="prompt-actions">
                    <button className="btn ghost" disabled={busyThis || batch} onClick={() => setPromptFor(tab, e, designPrompt(tab, e))}>
                      按当前基调重置
                    </button>
                  </div>
                </div>
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
