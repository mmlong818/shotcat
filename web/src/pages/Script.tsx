import { useEffect, useState } from 'react'
import { api, type Chapter, type Project } from '../lib/api'

export default function Script({ project }: { project: Project | null }) {
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [newText, setNewText] = useState('')
  const [saving, setSaving] = useState('')
  const [pipe, setPipe] = useState('')
  const [msg, setMsg] = useState('')

  const load = () => {
    if (!project) return
    api.chapters(project.id).then((cs) => {
      setChapters(cs)
      const d: Record<string, string> = {}
      cs.forEach((c) => (d[c.id] = c.raw_text || ''))
      setDraft(d)
    })
  }
  useEffect(load, [project])

  async function addChapter() {
    if (!project || !newText.trim()) return
    setSaving('new'); setMsg('')
    try {
      await api.createChapter(project.id, chapters.length + 1, `第${chapters.length + 1}集`, newText.trim())
      setNewText(''); load()
    } catch (e: any) { setMsg(e?.message || '创建失败') } finally { setSaving('') }
  }
  async function save(c: Chapter) {
    setSaving(c.id); setMsg('')
    try { await api.updateChapter(c.id, draft[c.id] || ''); setMsg(`第${c.index}集已保存`) }
    catch (e: any) { setMsg(e?.message || '保存失败') } finally { setSaving('') }
  }
  async function extract() {
    if (!project || pipe) return
    setPipe('x'); setMsg('抽取设定中…（读全剧本，约 1 分钟）')
    try {
      const j = await api.runPipeline('extract-setup', project.id)
      await api.pollPipeline(j)
      setMsg('✓ 设定已抽取 → 去「设定」页「① 锁定视觉词典」细化并生成造型图，再「分镜」页「AI 拆镜头」')
    } catch (e: any) { setMsg(e?.message || '抽取失败（pipeline 服务未起？）') } finally { setPipe('') }
  }

  if (!project) return <div className="center">请从作品库选择项目</div>

  return (
    <div className="work">
      <div className="work-head">
        <h1>剧本</h1>
        <div className="spacer" />
        <button className="btn primary" disabled={!!pipe || chapters.length === 0} onClick={extract}>
          {pipe ? '抽取设定中…' : '从剧本抽取设定'}
        </button>
      </div>
      {msg && <div className="sc-msg">{msg}</div>}

      {chapters.map((c) => (
        <div className="ep-block" key={c.id}>
          <div className="ep-h">
            <span className="ep-t">第 {c.index} 集 · {c.title}</span>
            <span className="ep-cnt">{(draft[c.id] || '').length} 字</span>
            <button className="btn ghost" disabled={saving === c.id} onClick={() => save(c)}>
              {saving === c.id ? '保存中…' : '保存'}
            </button>
          </div>
          <textarea className="sc-area" value={draft[c.id] ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))}
            placeholder="粘贴/编辑该集剧本正文（场景、动作、对白）…" />
        </div>
      ))}

      <div className="ep-block">
        <div className="ep-h"><span className="ep-t">＋ 新增一集</span>
          <button className="btn primary" disabled={saving === 'new' || !newText.trim()} onClick={addChapter}>
            {saving === 'new' ? '创建中…' : `保存为第 ${chapters.length + 1} 集`}
          </button>
        </div>
        <textarea className="sc-area" value={newText} onChange={(e) => setNewText(e.target.value)}
          placeholder={chapters.length === 0 ? '把《回声》这样的剧本正文粘贴到这里，保存后点右上角「从剧本抽取设定」自动抽出角色/场景/道具…' : '粘贴下一集剧本正文…'} />
      </div>
    </div>
  )
}
