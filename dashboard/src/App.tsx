import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { LayoutGrid, Database, FlaskConical, Activity } from 'lucide-react'
import ContextPreview from '@/pages/ContextPreview'
import MemoryPool from '@/pages/MemoryPool'
import Overview from '@/pages/Overview'
import Sessions from '@/pages/Sessions'

const navigation = [
  { name: 'Overview', href: '/', icon: LayoutGrid },
  { name: 'Memories', href: '/memories', icon: Database },
  { name: 'Simulator', href: '/preview', icon: FlaskConical },
  { name: 'Sessions', href: '/sessions', icon: Activity },
]

function Sidebar() {
  const location = useLocation()

  return (
    <aside className="fixed inset-y-0 left-0 z-50 w-56 border-r border-border bg-card flex flex-col">
      {/* Logo */}
      <div className="h-14 flex items-center px-5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-foreground" />
          <span className="font-semibold text-sm">Memory</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4">
        <ul className="space-y-1">
          {navigation.map((item) => {
            const isActive = location.pathname === item.href
            return (
              <li key={item.name}>
                <NavLink
                  to={item.href}
                  className={`flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-base ${
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
      <div className="p-4 border-t border-border">
        <div className="text-2xs text-muted-foreground">
          Claude Memory Dashboard
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
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  )
}
