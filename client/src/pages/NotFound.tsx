import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";

/** Shown for any address the app has no page for. Uses the theme colours, so it follows light and dark mode. */
export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-4">
      <div className="glass w-full max-w-lg rounded-2xl px-6 py-10 text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full"
          style={{ background: "color-mix(in srgb, var(--destructive) 12%, transparent)" }}>
          <AlertCircle className="h-8 w-8" style={{ color: "var(--destructive)" }} />
        </div>

        <h1 className="text-4xl font-black text-foreground mb-2">404</h1>
        <h2 className="text-xl font-semibold text-foreground mb-3">Page Not Found</h2>
        <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
          Sorry, the page you are looking for doesn't exist.
          <br />
          It may have been moved or deleted.
        </p>

        <button type="button" onClick={() => setLocation("/")} className="ink-button ink-button-large">
          <Home className="w-4 h-4" /> Go Home
        </button>
      </div>
    </div>
  );
}
