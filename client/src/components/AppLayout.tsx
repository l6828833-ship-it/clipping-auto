import { useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useRequireAuth } from "@/hooks/useCustomAuth";
import { useTheme } from "@/contexts/ThemeContext";
import { toast } from "sonner";
import {
  LayoutDashboard, Film, User,
  Zap, LogOut, Menu, List, Wand2,
  Sun, Moon
} from "lucide-react";

const NAV_ITEMS = [
  { path: "/dashboard",              icon: LayoutDashboard, label: "Dashboard" },
  { path: "/dashboard/create",       icon: Wand2,           label: "Create" },
  { path: "/dashboard/top5-reels",   icon: List,            label: "Top 5 Reels" },
  { path: "/dashboard/clips",        icon: Film,            label: "Clips" },
  { path: "/dashboard/profile",      icon: User,            label: "Profile" },
];

// ─── Main layout ──────────────────────────────────────────────────────────────
interface AppLayoutProps { children: React.ReactNode; title?: string; }

export default function AppLayout({ children, title }: AppLayoutProps) {
  const { user, isLoading } = useRequireAuth();
  const { theme, toggleTheme } = useTheme();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const utils = trpc.useUtils();

  const logout = trpc.auth.logout.useMutation({
    onSuccess: async () => { await utils.auth.me.invalidate(); window.location.href = "/login"; },
    onError: () => toast.error("Logout failed"),
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "var(--cobalt)" }}>
            <Zap className="w-5 h-5 text-white animate-pulse" />
          </div>
          <div className="text-sm text-muted-foreground">Loading…</div>
        </div>
      </div>
    );
  }
  if (!user) return null;

  const initials = (user.name ?? user.email ?? "U").slice(0, 2).toUpperCase();

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-border">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: "var(--cobalt)" }}>
            <Zap className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-black tracking-tight text-foreground">ShortsPro AI</div>
            <div className="text-[10px] text-muted-foreground">Video Platform</div>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-4 px-2">
        <nav className="space-y-0.5">
          {NAV_ITEMS.map(item => {
            const active = location === item.path;
            return (
              <Link key={item.path} href={item.path} onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 ${active ? "text-white" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
                style={active ? { background: "var(--cobalt)", boxShadow: "0 2px 12px rgba(49, 94, 245, 0.25)" } : {}}>
                <item.icon className="w-4 h-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* User footer */}
      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-secondary transition-colors">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
            style={{ background: "var(--cobalt)" }}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-foreground truncate">{user.name ?? "User"}</div>
            <div className="text-[10px] text-muted-foreground truncate">{user.email}</div>
          </div>
          <button onClick={() => logout.mutate()}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" title="Sign out">
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col sidebar">
        <SidebarContent />
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <aside className="relative w-64 flex flex-col sidebar animate-slide-up"><SidebarContent /></aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-border bg-background/90 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <button className="lg:hidden p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" onClick={() => setMobileOpen(true)}>
              <Menu className="w-4 h-4" />
            </button>
            {title && <h1 className="text-base font-bold text-foreground">{title}</h1>}
          </div>
          <button
            onClick={toggleTheme}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
}
