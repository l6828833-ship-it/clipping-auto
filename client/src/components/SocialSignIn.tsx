const messages = new Map([
  ["unavailable", "Social sign-in is temporarily unavailable."],
  ["cancelled", "Sign-in was cancelled. You can try again."],
  ["failed", "We couldn’t complete sign-in. Try again or sign in with email."],
]);

export default function SocialSignIn() {
  const result = new URLSearchParams(window.location.search).get("oauth");
  const message = result ? messages.get(result) : undefined;

  return (
    <div className="mb-6 space-y-3">
      {message && (
        <p role="alert" className="rounded-xl border border-border bg-input px-4 py-3 text-sm text-foreground">
          {message}
        </p>
      )}
      {[
        { provider: "google", label: "Continue with Google" },
        { provider: "apple", label: "Sign in with Apple" },
      ].map(({ provider, label }) => (
        <a
          key={provider}
          href={`/api/auth/supabase/start/${provider}`}
          className="flex w-full items-center justify-center rounded-xl border border-border bg-background px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
        >
          {label}
        </a>
      ))}
      <div className="flex items-center gap-3 pt-2 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or use email
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
