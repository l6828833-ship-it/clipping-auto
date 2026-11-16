import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2, MailCheck, Zap } from "lucide-react";
import { useRedirectIfAuth } from "@/hooks/useCustomAuth";

const googleButton = new URL("../assets/sign-in-with-google.png", import.meta.url).href;

export function AuthOptions({ children }: { children: ReactNode }) {
  const config = useQuery({
    queryKey: ["auth-options"],
    staleTime: 60_000,
    queryFn: async (): Promise<{ site: string | null }> => {
      const response = await fetch("/api/auth/config");
      if (response.status === 404) return { site: null };
      if (!response.ok) throw new Error("Sign-in options are unavailable.");
      return response.json();
    },
  });

  if (config.isPending) {
    return <main className="min-h-screen grid place-items-center" aria-busy="true"><Loader2 className="w-6 h-6 animate-spin" /></main>;
  }
  if (config.isError) {
    return <main className="min-h-screen grid place-items-center text-sm" role="alert">Sign-in options couldn’t load. Refresh to try again.</main>;
  }
  return config.data.site ? <PasswordlessAuth site={config.data.site} /> : children;
}

function PasswordlessAuth({ site }: { site: string }) {
  useRedirectIfAuth();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [isSending, setIsSending] = useState(false);
  const callback = new URLSearchParams(window.location.search).get("auth");
  const [error, setError] = useState(
    callback === "email" ? "That link has expired or was already used. Enter your email to get a new one."
      : callback === "google" ? "Google sign-in couldn’t finish. Try again." : "",
  );
  const canonical = window.location.origin === site;

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    setError("");
    setSentTo("");
    setIsSending(true);
    try {
      const response = await fetch("/api/auth/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message ?? "We couldn’t send a sign-in link. Try again in a moment.");
      }
      setSentTo(address);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn’t send a sign-in link.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="relative min-h-screen bg-background flex items-center justify-center p-4">
      <div className="absolute inset-0 pointer-events-none opacity-40" aria-hidden="true"
        style={{
          backgroundImage: "linear-gradient(rgba(235,232,223,.85) 1px, transparent 1px), linear-gradient(90deg, rgba(235,232,223,.85) 1px, transparent 1px)",
          backgroundSize: "12px 12px",
          maskImage: "radial-gradient(ellipse at center, black 10%, transparent 70%)",
        }}
      />
      <section className="relative w-full max-w-md">
        <header className="text-center mb-7">
          <div className="inline-flex items-center gap-2 mb-4 text-2xl font-black tracking-tight">
            <span className="w-10 h-10 rounded-xl grid place-items-center glow-blue" style={{ background: "var(--cobalt)" }}>
              <Zap className="w-5 h-5 text-white" aria-hidden="true" />
            </span>
            Clip Maker
          </div>
          <h1 className="text-3xl font-bold tracking-tight">{sentTo ? "Check your email" : "Sign in to Clip Maker"}</h1>
          {!sentTo && (
            <p className="text-sm text-muted-foreground mt-2">
              Enter your email and we’ll send you a link. No password needed. New here? The same link creates your account.
            </p>
          )}
        </header>

        <div className="glass rounded-2xl p-6 sm:p-8 space-y-5">
          {!canonical ? (
            <a className="text-sm font-semibold underline" href={`${site}/login`}>Continue to Clip Maker</a>
          ) : sentTo ? (
            <div role="status" className="text-center space-y-3">
              <span className="mx-auto w-12 h-12 rounded-full grid place-items-center"
                style={{ background: "color-mix(in srgb, var(--mint) 15%, transparent)" }}>
                <MailCheck className="w-6 h-6" style={{ color: "var(--mint)" }} aria-hidden="true" />
              </span>
              <p className="text-sm break-words">
                We sent a sign-in link to <span className="font-semibold">{sentTo}</span>.
              </p>
              <p className="text-sm text-muted-foreground">Open the link in the email to continue. It can take a minute to arrive; check your spam folder too.</p>
              <button type="button" onClick={() => { setSentTo(""); setError(""); }}
                className="text-sm font-semibold underline" style={{ color: "var(--cobalt)" }}>
                Use a different email
              </button>
            </div>
          ) : (
            <>
              <a href="/api/auth/google" className="flex w-fit mx-auto rounded-full hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-4">
                <img src={googleButton} className="h-10 w-auto" alt="Sign in with Google" />
              </a>
              <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
                <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
              </div>
              <form onSubmit={sendLink} className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium" htmlFor="signin-email">Email address</label>
                  <input
                    id="signin-email"
                    type="email"
                    autoComplete="email"
                    maxLength={320}
                    required
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    className="w-full px-4 py-3 rounded-xl bg-input border border-border placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isSending}
                  className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-full font-bold text-sm text-white hover:opacity-90 disabled:opacity-50 glow-blue"
                  style={{ background: "var(--cobalt)" }}
                >
                  {isSending
                    ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Sending…</>
                    : <>Continue with email <ArrowRight className="w-4 h-4" aria-hidden="true" /></>}
                </button>
              </form>
            </>
          )}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
      </section>
    </main>
  );
}
