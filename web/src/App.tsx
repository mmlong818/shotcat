import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { api, type Project } from './lib/api'
import Storyboard from './pages/Storyboard'
import Cast from './pages/Cast'
import Frames from './pages/Frames'
import Lobby from './pages/Lobby'
import Overview from './pages/Overview'
import Script from './pages/Script'

const STAGES = [
  { key: 'script', label: '剧本', to: '/script' },
  { key: 'cast', label: '设定', to: '/cast' },
  { key: 'board', label: '分镜', to: '/board' },
  { key: 'frames', label: '画面', to: '/frames' },
]
const STAGE_PATHS = ['/script', '/cast', '/board', '/frames', '/settings']

function Icon({ name }: { name: string }) {
  const p: Record<string, JSX.Element> = {
    home: <g><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></g>,
    overview: <g><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></g>,
    script: <path d="M5 3h9l5 5v13H5zM14 3v5h5" />,
    cast: <g><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></g>,
    board: <g><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 4v16" /></g>,
    frames: <g><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h4v10M17 5v14h4M7 5v4" /></g>,
    settings: <g><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></g>,
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">{p[name]}</svg>
}

function Placeholder({ title }: { title: string }) {
  return <div className="center">{title} · 界面建设中</div>
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null)
  const navigate = useNavigate()
  const loc = useLocation()
  const inStage = STAGE_PATHS.some((p) => loc.pathname.startsWith(p)) // 阶段页才显示左轨；作品库/项目页独立

  // 启动：载入项目列表，恢复上次选中的项目
  useEffect(() => {
    api.projects().then((ps) => {
      const urlPid = new URLSearchParams(window.location.search).get('pid')
      const wantId = urlPid || localStorage.getItem('duanju.pid')
      const found = ps.find((p) => p.id === wantId) ?? null
      setProject(found)
      if (found) localStorage.setItem('duanju.pid', found.id)
    }).catch(() => {})
  }, [])

  const openProject = (p: Project) => {
    setProject(p)
    localStorage.setItem('duanju.pid', p.id)
    navigate('/overview')
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand" style={{ cursor: 'pointer' }} onClick={() => navigate('/projects')} title="返回作品库">
          <span className="dot" />
          <span>猫叔的短剧工作台</span>
        </div>
        <span className="crumb">
          {project ? <>项目 · <b>{project.name}</b></> : <>请选择或新建项目</>}
        </span>
        {project && (
          <label className="ratio-sel" title="画幅比例（项目级，影响生图/生视频）">
            画幅
            <select
              value={project.default_video_ratio || '9:16'}
              onChange={(e) => {
                const r = e.target.value
                api.updateProject(project.id, { default_video_ratio: r }).catch(() => {})
                setProject({ ...project, default_video_ratio: r })
              }}
            >
              {['9:16', '16:9', '1:1', '4:3', '3:4', '2:3', '3:2', '21:9'].map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
        <div className="progress">
          <div className="track"><div className="fill" style={{ width: `${project?.progress ?? 0}%` }} /></div>
          <span className="pct">{project?.progress ?? 0}%</span>
        </div>
        <div className="spacer" />
        <div className="search"><span>搜索镜头、角色、资产…</span><kbd>⌘K</kbd></div>
        <div className="tb-icon" title="切换项目" onClick={() => navigate('/projects')} style={{ cursor: 'pointer' }}>⇄</div>
        <div className="avatar">猫</div>
      </div>

      <div className="body" style={{ gridTemplateColumns: inStage ? '76px 1fr' : '1fr' }}>
        {inStage && (
          <div className="rail">
            <NavLink to="/overview" className="nav" title="返回项目概览">
              <Icon name="overview" />项目
            </NavLink>
            <div className="flow-line" />
            {STAGES.map((s, i) => (
              <div key={s.key} style={{ display: 'contents' }}>
                {i > 0 && <div className="flow-line" />}
                <NavLink to={s.to} className={({ isActive }) => 'nav' + (isActive ? ' active' : '')}>
                  <Icon name={s.key} />{s.label}
                </NavLink>
              </div>
            ))}
            <NavLink to="/settings" className="nav bottom"><Icon name="settings" />设置</NavLink>
          </div>
        )}

        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<Lobby onOpen={openProject} />} />
          <Route path="/overview" element={<Overview project={project} />} />
          <Route path="/board" element={<Storyboard project={project} />} />
          <Route path="/script" element={<Script project={project} />} />
          <Route path="/cast" element={<Cast project={project} />} />
          <Route path="/frames" element={<Frames project={project} />} />
          <Route path="/settings" element={<Placeholder title="设置" />} />
        </Routes>
      </div>
    </div>
  )
}
