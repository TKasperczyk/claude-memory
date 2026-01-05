import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { LayoutGrid, Database, FlaskConical, Activity, Wrench, FileText } from 'lucide-react'
import ContextPreview from '@/pages/ContextPreview'
import Extractions from '@/pages/Extractions'
import MemoryPool from '@/pages/MemoryPool'
import Maintenance from '@/pages/Maintenance'
import Overview from '@/pages/Overview'
import Sessions from '@/pages/Sessions'

const navigation = [
  { name: 'Overview', href: '/', icon: LayoutGrid },
  { name: 'Memories', href: '/memories', icon: Database },
  { name: 'Simulator', href: '/preview', icon: FlaskConical },
  { name: 'Sessions', href: '/sessions', icon: Activity },
  { name: 'Extractions', href: '/extractions', icon: FileText },
  { name: 'Maintenance', href: '/maintenance', icon: Wrench },
]

function Sidebar() {
  const location = useLocation()

  return (
    <aside className="fixed inset-y-0 left-0 z-50 w-56 border-r border-border/50 bg-background flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center px-5">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-type-discovery" />
          <span className="font-semibold text-sm tracking-tight">Memory</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2">
        <ul className="space-y-0.5">
          {navigation.map((item) => {
            const isActive = location.pathname === item.href
            return (
              <li key={item.name}>
                <NavLink
                  to={item.href}
                  className={`flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-base ${
                    isActive
                      ? 'bg-secondary text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                  }`}
                >
                  <item.icon className="w-4 h-4" strokeWidth={1.5} />
                  {item.name}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="px-5 py-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
          Claude Memory
        </div>
      </div>
    </aside>
  )
}

function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  )
}

export { PageHeader }

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background">
        <Sidebar />
        <main className="pl-56">
          <div className="max-w-6xl mx-auto px-8 py-8">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/memories" element={<MemoryPool />} />
              <Route path="/preview" element={<ContextPreview />} />
              <Route path="/sessions" element={<Sessions />} />
              <Route path="/extractions" element={<Extractions />} />
              <Route path="/maintenance" element={<Maintenance />} />
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  )
}
