import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { 
  Brain, 
  LayoutDashboard, 
  MessageSquare, 
  Bot, 
  FileText, 
  Code, 
  Mic, 
  Settings, 
  User,
  LogOut,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Search,
  CheckSquare,
  FolderOpen
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

interface AppLayoutProps {
  children: React.ReactNode;
}

const navigation = [
  { name: 'Dashboard', href: '/app/dashboard', icon: LayoutDashboard },
  { name: 'AI Chat', href: '/app/chat', icon: MessageSquare },
  { name: 'Agents', href: '/app/agents', icon: Bot },
  { name: 'Documents', href: '/app/documents', icon: FileText },
  { name: 'Code Studio', href: '/app/code-studio', icon: Code },
  { name: 'Voice AI', href: '/app/voice', icon: Mic },
  { name: 'Workspace', href: '/app/workspace', icon: CheckSquare },
  { name: 'File Actions', href: '/app/files', icon: FolderOpen },
];

export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    return localStorage.getItem('nexus-sidebar-collapsed') === 'true';
  });
  
  const [theme, setTheme] = useState<'dark'|'light'>(() => {
    return (localStorage.getItem('nexus-theme') as 'dark'|'light') || 'dark';
  });

  useEffect(() => {
    localStorage.setItem('nexus-sidebar-collapsed', String(isCollapsed));
  }, [isCollapsed]);

  useEffect(() => {
    localStorage.setItem('nexus-theme', theme);
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // Global Ctrl+K / Cmd+K handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        // In a real app we'd open a command palette modal
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const NavItem = ({ item }: { item: typeof navigation[0] }) => {
    const isActive = location.pathname === item.href || (item.href !== '/app/dashboard' && location.pathname.startsWith(item.href));
    
    return (
      <Link
        to={item.href}
        onClick={() => setMobileMenuOpen(false)}
        className="relative group flex items-center mb-1"
        aria-label={item.name}
      >
        <div className={`
          flex items-center w-full rounded-lg transition-all duration-200
          ${isCollapsed ? 'justify-center py-3 mx-2 w-auto flex-1' : 'px-3 py-2 space-x-3'}
          ${isActive 
            ? 'bg-gradient-to-r from-primary/20 to-primary/5 text-primary' 
            : 'text-gray-400 hover:text-white hover:bg-white/5'
          }
        `}>
          {isActive && (
            <motion.div 
              layoutId="activeNavIndicator"
              className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-primary to-cyan-500 rounded-r-md"
            />
          )}
          
          <item.icon className={`flex-shrink-0 ${isCollapsed ? 'w-6 h-6' : 'w-5 h-5'} ${isActive ? 'text-primary' : ''}`} />
          
          {!isCollapsed && (
            <span className={`font-medium ${isActive ? 'text-white' : ''}`}>
              {item.name}
            </span>
          )}
        </div>
        
        {/* Tooltip for collapsed state */}
        {isCollapsed && (
          <div className="absolute left-full ml-2 px-2 py-1 bg-[#1a1d2d] border border-white/10 text-xs text-white rounded-md opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50">
            {item.name}
          </div>
        )}
      </Link>
    );
  };

  return (
    <div className={`flex h-screen overflow-hidden ${theme === 'dark' ? 'bg-[#09090B] text-white' : 'bg-gray-50 text-gray-900'} transition-colors duration-300`}>
      {/* Mobile sidebar overlay */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside 
        className={`
          fixed inset-y-0 left-0 z-50 bg-[#09090B]/95 backdrop-blur-xl border-r border-white/10 
          transition-all duration-300 ease-in-out flex flex-col shadow-2xl
          ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
          lg:translate-x-0 lg:static lg:inset-0
          ${isCollapsed ? 'w-[80px]' : 'w-64'}
        `}
      >
        {/* Header */}
        <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'justify-between'} p-4 border-b border-white/10 h-[73px] shrink-0`}>
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-gradient-to-br from-primary to-cyan-500 rounded-xl flex items-center justify-center flex-shrink-0 shadow-[0_0_15px_rgba(139,92,246,0.3)]">
              <Brain className="w-5 h-5 text-white" />
            </div>
            {!isCollapsed && (
              <motion.span 
                initial={{ opacity: 0, width: 0 }} 
                animate={{ opacity: 1, width: 'auto' }} 
                className="text-xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-300"
              >
                KFive AI
              </motion.span>
            )}
          </div>
          
          <button
            onClick={() => setMobileMenuOpen(false)}
            className="lg:hidden p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
          
          {!isCollapsed && (
            <button 
              onClick={() => setIsCollapsed(true)}
              className="hidden lg:block p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-4 px-2 scrollbar-none flex flex-col gap-1">
          {/* Search shortcut hint */}
          {!isCollapsed && (
            <div className="mb-4 px-3 py-2.5 mx-1 bg-white/5 border border-white/5 rounded-xl flex items-center justify-between text-sm text-gray-400 cursor-pointer hover:bg-white/10 transition-colors group">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 group-hover:text-primary transition-colors" />
                <span>Search</span>
              </div>
              <div className="flex items-center gap-1 opacity-60">
                <span className="px-1.5 py-0.5 bg-black/40 rounded text-[10px] font-medium border border-white/10">⌘</span>
                <span className="px-1.5 py-0.5 bg-black/40 rounded text-[10px] font-medium border border-white/10">K</span>
              </div>
            </div>
          )}

          {/* Navigation */}
          <nav className="flex-1 space-y-1">
            {navigation.map((item) => (
              <NavItem key={item.name} item={item} />
            ))}
          </nav>
        </div>

        {/* User section */}
        <div className="p-4 border-t border-white/10 mt-auto bg-black/20 shrink-0">
          <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'space-x-3'} mb-4`}>
            <div className="w-9 h-9 bg-gradient-to-br from-cyan-500 to-primary rounded-full flex items-center justify-center flex-shrink-0 shadow-md border border-white/10">
              <span className="text-sm font-bold text-white">
                {user?.firstName?.[0] || user?.username?.[0] || 'U'}
              </span>
            </div>
            {!isCollapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-200 truncate">
                  {user?.firstName ? `${user.firstName} ${user.lastName || ''}` : user?.username}
                </p>
                <p className="text-xs text-gray-500 truncate">{user?.email}</p>
              </div>
            )}
          </div>
          
          <div className={`flex ${isCollapsed ? 'flex-col gap-2' : 'gap-1'}`}>
            <Link
              to="/app/profile"
              onClick={() => setMobileMenuOpen(false)}
              className={`flex items-center justify-center p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors ${!isCollapsed && 'flex-1'}`}
              aria-label="Profile"
            >
              <User className="w-4 h-4" />
            </Link>
            <Link
              to="/app/settings"
              onClick={() => setMobileMenuOpen(false)}
              className={`flex items-center justify-center p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors ${!isCollapsed && 'flex-1'}`}
              aria-label="Settings"
            >
              <Settings className="w-4 h-4" />
            </Link>
            <button
              onClick={toggleTheme}
              className={`flex items-center justify-center p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors ${!isCollapsed && 'flex-1'}`}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              onClick={handleLogout}
              className={`flex items-center justify-center p-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors ${!isCollapsed && 'flex-1'}`}
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
          
          {isCollapsed && (
            <button 
              onClick={() => setIsCollapsed(false)}
              className="mt-4 w-full flex items-center justify-center p-2 text-gray-500 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Expand sidebar"
            >
              <PanelLeftOpen className="w-5 h-5" />
            </button>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-transparent h-screen overflow-hidden">
        {/* Mobile header */}
        <div className="lg:hidden flex items-center justify-between p-4 border-b border-white/10 bg-[#09090B]/95 backdrop-blur-xl shrink-0">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="p-2 -ml-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10"
            aria-label="Open menu"
          >
            <Menu className="w-6 h-6" />
          </button>
          
          {/* Breadcrumb / Page Title */}
          <div className="flex-1 text-center font-semibold text-gray-200">
            {navigation.find(n => location.pathname.startsWith(n.href))?.name || 'KFive AI'}
          </div>
          
          <div className="w-10"></div> {/* Spacer */}
        </div>

        {/* Page content wrapper */}
        <div className="flex-1 overflow-auto bg-transparent relative">
          {children}
        </div>
      </main>
    </div>
  );
}