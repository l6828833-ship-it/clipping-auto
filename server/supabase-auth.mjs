import { createHash, randomBytes } from "node:crypto";
import { parse } from "cookie";
import express from "express";
import { z } from "zod";

const prefix = "/api/auth";
const emailCallback = `${prefix}/email/confirm`;
const googleCallback = `${prefix}/google/callback`;
const emailAddress = z.string().trim().toLowerCase().max(320).email();
const supabaseUser = z.object({
  id: z.string().uuid(),
  email: emailAddress,
  email_confirmed_at: z.string().datetime({ offset: true }),
  user_metadata: z.object({
    name: z.string().optional(),
    full_name: z.string().optional(),
  }).optional(),
});

function authOrigin(value) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Supabase auth URLs must be HTTPS origins or local development origins");
  }
  return url.origin;
}

export function readSupabaseAuthConfig(env) {
  const url = env.CLIP_MAKER_AUTH_SUPABASE_URL?.trim();
  const key = env.CLIP_MAKER_AUTH_SUPABASE_KEY?.trim();
  const site = env.CLIP_MAKER_AUTH_SITE_URL?.trim();
  if (!url && !key && !site) return null;
  if (!url || !key?.startsWith("sb_publishable_") || !site || !env.JWT_SECRET?.trim()) {
    throw new Error("Supabase auth requires CLIP_MAKER_AUTH_SUPABASE_URL, a publishable CLIP_MAKER_AUTH_SUPABASE_KEY, CLIP_MAKER_AUTH_SITE_URL, and JWT_SECRET");
  }
  return { url: authOrigin(url), key, site: authOrigin(site) };
}

async function supabasePost(config, path, body) {
  const response = await fetch(`${config.url}/auth/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: config.key },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    // Auth responses can contain private information. Keep only the status.
    await response.body?.cancel();
    throw Object.assign(new Error("Supabase auth request failed"), { status: response.status });
  }
  return response.json();
}

function challengeFor(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function registerSupabaseAuth(app, config, { linkUser, setSession }) {
  app.use(prefix, (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    next();
  });
  app.get(`${prefix}/config`, (_req, res) => res.json({ site: config?.site ?? null }));
  if (!config) return;

  const secure = config.site.startsWith("https:");
  const cookieOptions = { httpOnly: true, secure, sameSite: "lax", path: "/" };
  const cookieName = method => `${secure ? "__Host-" : ""}clip-maker-${method}-pkce`;

  app.get(`${prefix}/google`, (_req, res) => {
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(`${config.url}/auth/v1/authorize`);
    url.search = new URLSearchParams({
      provider: "google",
      redirect_to: `${config.site}${googleCallback}`,
      code_challenge: challengeFor(verifier),
      code_challenge_method: "s256",
    }).toString();
    res.cookie(cookieName("google"), verifier, { ...cookieOptions, maxAge: 10 * 60 * 1000 });
    return res.redirect(303, url.href);
  });

  app.post(`${prefix}/email`, express.json({ limit: "2kb" }), async (req, res) => {
    // The reverse proxy can rewrite Host. Origin identifies the browser page making this request.
    if (req.get("origin") !== config.site) return res.sendStatus(403);
    const email = emailAddress.safeParse(req.body?.email);
    if (!email.success) return res.status(400).json({ message: "Enter a valid email address." });

    const verifier = randomBytes(32).toString("base64url");
    try {
      const query = new URLSearchParams({ redirect_to: `${config.site}${emailCallback}` });
      await supabasePost(config, `/otp?${query}`, {
        email: email.data,
        create_user: true,
        code_challenge: challengeFor(verifier),
        code_challenge_method: "s256",
      });
      res.cookie(cookieName("email"), verifier, { ...cookieOptions, maxAge: 60 * 60 * 1000 });
      return res.json({ sent: true });
    } catch (error) {
      if (error.status === 429) {
        return res.status(429).json({ message: "Please wait a minute before requesting another link." });
      }
      console.warn("[Auth] Email link request failed", error.status ?? error.name);
      return res.status(503).json({ message: "We couldn’t send a sign-in link. Try again in a moment." });
    }
  });

  /**
   * The address the emailed link opens. Two kinds of link arrive here:
   *
   * - `?token_hash=…`: from an email template that links straight to this
   *   address. The hash alone proves the click, so the link works in any
   *   browser or device, like other "email me a link" sign-ins. It arrives
   *   posted from the page the link opens (see `confirmPage`).
   * - `?code=…`: from Supabase's default template, which goes through
   *   Supabase first. That code is only good together with the cookie set when
   *   the link was requested, so it works only in the browser that asked.
   */
  function finishSignIn(method) {
    return async (req, res) => {
      const failed = `/login?auth=${method}`;
      const { code, token_hash: tokenHash, error: providerError } = req.method === "POST" ? req.body ?? {} : req.query;
      if (providerError) return res.redirect(303, failed);
      try {
        let session;
        if (method === "email" && typeof tokenHash === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(tokenHash)) {
          session = await supabasePost(config, "/verify", { type: "email", token_hash: tokenHash });
        } else {
          const verifier = parse(req.headers.cookie ?? "")[cookieName(method)];
          if (typeof code !== "string" || !code || code.length > 256 || !verifier || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) {
            return res.redirect(303, failed);
          }
          session = await supabasePost(config, "/token?grant_type=pkce", { auth_code: code, code_verifier: verifier });
        }
        const identity = supabaseUser.parse(session.user);
        const account = await linkUser(identity, method);
        await setSession(req, res, account, secure);
        res.clearCookie(cookieName(method), cookieOptions);
        return res.redirect(303, "/dashboard");
      } catch (error) {
        /* Database errors carry a code and the name of the table, column or
         * rule involved, which says what went wrong without any of the data. */
        const detail = error.code
          ? ` code=${error.code}${error.table ? ` table=${error.table}` : ""}${error.column ? ` column=${error.column}` : ""}${error.constraint ? ` constraint=${error.constraint}` : ""}${error.routine ? ` routine=${error.routine}` : ""}`
          : "";
        console.warn("[Auth] Could not complete sign-in", method, error.status ?? error.name, detail);
        return res.redirect(303, failed);
      }
    };
  }

  /* A `token_hash` link no longer signs in when it is opened. Mail scanners
   * (Outlook Safe Links and the like) open every link in new mail, which used
   * up the one-time link before the person clicked it. And anyone could send
   * a link of their own and silently sign the reader into the sender's
   * account, where connecting YouTube or TikTok would hand the sender those
   * channels. Opening the link shows a page; its button signs in with a POST,
   * which the Origin check confines to this site. `?code=` links need this
   * browser's cookie, so they still finish on the GET. */
  app.get(emailCallback, (req, res, next) => {
    const tokenHash = req.query.token_hash;
    if (tokenHash === undefined) return next();
    if (typeof tokenHash !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(tokenHash)) {
      return res.redirect(303, "/login?auth=email");
    }
    res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return res.type("html").send(confirmPage(tokenHash));
  }, finishSignIn("email"));
  app.post(emailCallback, express.urlencoded({ extended: false, limit: "2kb" }), (req, res, next) => {
    if (req.get("origin") !== config.site) return res.sendStatus(403);
    return next();
  }, finishSignIn("email"));
  app.get(googleCallback, finishSignIn("google"));
}

/** The page an emailed sign-in link opens. `tokenHash` is already checked to
 * be URL-safe base64, so it needs no escaping. */
function confirmPage(tokenHash) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Sign in to Clip Maker</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8eaf0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:22rem;padding:2rem;text-align:center}
h1{font-size:1.4rem;margin:0 0 .5rem}
p{color:#a3a9b8;margin:0 0 1.5rem}
button{width:100%;padding:.8rem 1rem;border:0;border-radius:.6rem;background:#3b82f6;color:#fff;font:600 1rem system-ui,sans-serif;cursor:pointer}
</style></head>
<body><main>
<h1>Sign in to Clip Maker</h1>
<p>Continue only if you asked for this sign-in link.</p>
<form method="post" action="${emailCallback}">
<input type="hidden" name="token_hash" value="${tokenHash}">
<button type="submit">Sign in</button>
</form>
</main></body></html>`;
}
