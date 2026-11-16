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
   *   browser or device, like other "email me a link" sign-ins.
   * - `?code=…`: from Supabase's default template, which goes through
   *   Supabase first. That code is only good together with the cookie set when
   *   the link was requested, so it works only in the browser that asked.
   */
  function finishSignIn(method) {
    return async (req, res) => {
      const failed = `/login?auth=${method}`;
      const { code, token_hash: tokenHash, error: providerError } = req.query;
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

  app.get(emailCallback, finishSignIn("email"));
  app.get(googleCallback, finishSignIn("google"));
}
