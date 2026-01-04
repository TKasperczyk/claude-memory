import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import ContextPreview from '@/pages/ContextPreview'
import MemoryPool from '@/pages/MemoryPool'
import Overview from '@/pages/Overview'
import Sessions from '@/pages/Sessions'

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm font-semibold uppercase tracking-[0.25em] transition ${
    isActive ? 'text-white' : 'text-slate-400 hover:text-white'
  }`

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-grid relative overflow-hidden">
        <div className="pointer-events-none fixed inset-0 -z-10">
          <div className="absolute -top-48 left-1/2 h-[420px] w-[420px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(16,185,129,0.22),transparent_65%)] blur-2xl animate-float" />
          <div className="absolute -bottom-40 right-0 h-[380px] w-[380px] rounded-full bg-[radial-gradient(circle,rgba(251,191,36,0.2),transparent_65%)] blur-2xl animate-float" />
        </div>
        <nav className="sticky top-0 z-40 border-b border-white/5 bg-slate-950/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <NavLink to="/" className="text-lg font-semibold text-white">
              Claude Memory
            </NavLink>
            <div className="flex items-center gap-6">
              <NavLink to="/" className={navLinkClass} end>
                Overview
              </NavLink>
              <NavLink to="/memories" className={navLinkClass}>
                Memories
              </NavLink>
              <NavLink to="/preview" className={navLinkClass}>
                Preview
              </NavLink>
              <NavLink to="/sessions" className={navLinkClass}>
                Sessions
              </NavLink>
            </div>
          </div>
        </nav>
        <main className="mx-auto max-w-7xl px-6 py-10">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/memories" element={<MemoryPool />} />
            <Route path="/preview" element={<ContextPreview />} />
            <Route path="/sessions" element={<Sessions />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
