import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { LayoutGrid, Database, FlaskConical, Activity, Wrench, FileText, Settings as SettingsIcon, MessageSquare } from 'lucide-react'
import ContextPreview from '@/pages/ContextPreview'
import Extractions from '@/pages/Extractions'
import Chat from '@/pages/Chat'
import MemoryPool from '@/pages/MemoryPool'
import Maintenance from '@/pages/Maintenance'
import Overview from '@/pages/Overview'
import Sessions from '@/pages/Sessions'
import Settings from '@/pages/Settings'

const navigation = [
  { name: 'Overview', href: '/', icon: LayoutGrid },
  { name: 'Chat', href: '/chat', icon: MessageSquare },
  { name: 'Memories', href: '/memories', icon: Database },
  { name: 'Simulator', href: '/preview', icon: FlaskConical },
  { name: 'Sessions', href: '/sessions', icon: Activity },
  { name: 'Extractions', href: '/extractions', icon: FileText },
  { name: 'Maintenance', href: '/maintenance', icon: Wrench },
  { name: 'Settings', href: '/settings', icon: SettingsIcon },
]

function Sidebar() {
  const location = useLocation()

  return (
    <aside className="fixed inset-y-0 left-0 z-50 w-52 border-r border-sidebar-border bg-sidebar backdrop-blur-sm flex flex-col">
      {/* Logo */}
      <div className="h-14 flex items-center px-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 rounded-full bg-type-discovery shadow-[0_0_8px_rgba(96,165,250,0.4)]" />
          <span className="font-semibold text-[15px] tracking-tight">Memory</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2.5 py-4">
        <ul className="space-y-1">
          {navigation.map((item) => {
            const isActive = location.pathname === item.href
            return (
              <li key={item.name}>
                <NavLink
                  to={item.href}
                  className={`flex items-center gap-3 px-3 py-2 text-[13px] rounded-lg transition-all duration-150 ${
                    isActive
                      ? 'bg-secondary/80 text-foreground font-medium shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'
                  }`}
                >
                  <item.icon className="w-4 h-4 shrink-0" strokeWidth={1.5} />
                  {item.name}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-sidebar-border">
        <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/50 font-medium">
          Claude Memory
        </div>
      </div>
    </aside>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background">
        <Sidebar />
        <main className="pl-52 min-h-screen">
          <div className="max-w-6xl xl:max-w-7xl 2xl:max-w-[1600px] mx-auto px-6 lg:px-8 py-6 w-full">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/memories" element={<MemoryPool />} />
              <Route path="/preview" element={<ContextPreview />} />
              <Route path="/sessions" element={<Sessions />} />
              <Route path="/extractions" element={<Extractions />} />
              <Route path="/maintenance" element={<Maintenance />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  )
}
