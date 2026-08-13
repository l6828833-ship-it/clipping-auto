import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import LoginPage from "./pages/Login";
import RegisterPage from "./pages/Register";
import DashboardPage from "./pages/Dashboard";
import CreatePage from "./pages/Create";
import Top5ReelsPage from "./pages/Top5Reels";
import SubtitleEditorPage from "./pages/SubtitleEditor";
import ClipsPage from "./pages/Clips";
import ProfilePage from "./pages/Profile";
import Home from "./pages/Home";

function Router() {
  return (
    <Switch>
      <Route path="/"                          component={Home} />
      <Route path="/login"                     component={LoginPage} />
      <Route path="/register"                  component={RegisterPage} />
      <Route path="/dashboard"                 component={DashboardPage} />
      <Route path="/dashboard/create"          component={CreatePage} />
      <Route path="/dashboard/top5-reels"      component={Top5ReelsPage} />
      <Route path="/dashboard/subtitle-editor" component={SubtitleEditorPage} />
      <Route path="/dashboard/clips"           component={ClipsPage} />
      <Route path="/dashboard/profile"         component={ProfilePage} />
      <Route path="/404"                       component={NotFound} />
      <Route                                   component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Toaster position="top-right" />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
