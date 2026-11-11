import { createClient } from "@supabase/supabase-js";
import { parse } from "cookie";
import { SignJWT, jwtVerify } from "jose";

const providers = new Set(["google", "apple"]);
const callbackPath = "/api/auth/supabase/callback";
const flowAudience = "clip-maker-supabase-oauth";
const flowLifetime = 10 * 60;

function readConfig() {
  const { APP_ORIGIN, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, JWT_SECRET } = process.env;
  if (!APP_ORIGIN || !SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !JWT_SECRET) return null;

  const origin = new URL(APP_ORIGIN);
  const secure = origin.protocol === "https:";
  const local = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((!secure && !local) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("APP_ORIGIN must be the website origin");
  }
  return {
    url: SUPABASE_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    secret: new TextEncoder().encode(JWT_SECRET),
    callbackUrl: new URL(callbackPath, origin).href,
    cookieName: secure ? "__Host-clip-maker-oauth" : "clip-maker-oauth",
    cookieOptions: { httpOnly: true, secure, sameSite: "lax", path: "/" },
  };
}

function authClient(config, storage = new Map()) {
  return createClient(config.url, config.publishableKey, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key),
      },
    },
    global: {
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000) }),
    },
  }).auth;
}

export function registerSupabaseOAuth(app, { findUser, saveUser, setSession }) {
  app.use("/api/auth/supabase", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    next();
  });

  app.get("/api/auth/supabase/start/:provider", async (req, res) => {
    const { provider } = req.params;
    if (!providers.has(provider)) return res.sendStatus(404);

    try {
      const config = readConfig();
      if (!config) return res.redirect("/login?oauth=unavailable");

      const storage = new Map();
      const { data, error } = await authClient(config, storage).signInWithOAuth({
        provider,
        options: { redirectTo: config.callbackUrl, skipBrowserRedirect: true },
      });
      if (error || !data.url) return res.redirect("/login?oauth=unavailable");

      // Only the pending PKCE flow is stored in the browser. Provider tokens stay on the server.
      const flow = await new SignJWT({ provider, storage: [...storage], flowId: data.flowId })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience(flowAudience)
        .setExpirationTime(`${flowLifetime}s`)
        .sign(config.secret);
      res.cookie(config.cookieName, flow, { ...config.cookieOptions, maxAge: flowLifetime * 1000 });
      return res.redirect(data.url);
    } catch (error) {
      console.warn("[Supabase Auth] Could not start sign-in", error.name);
      return res.redirect("/login?oauth=unavailable");
    }
  });

  app.get(callbackPath, async (req, res) => {
    try {
      const config = readConfig();
      if (!config) return res.redirect("/login?oauth=unavailable");

      const flow = parse(req.headers.cookie ?? "")[config.cookieName];
      res.clearCookie(config.cookieName, config.cookieOptions);
      const { code, error: providerError } = req.query;
      if (providerError === "access_denied") return res.redirect("/login?oauth=cancelled");
      if (providerError || typeof code !== "string" || !code || !flow) return res.redirect("/login?oauth=failed");

      const { payload } = await jwtVerify(flow, config.secret, {
        algorithms: ["HS256"],
        audience: flowAudience,
      });
      const auth = authClient(config, new Map(payload.storage));
      const { data, error } = await auth.exchangeCodeForSession(code, payload.flowId ? { flowId: payload.flowId } : undefined);
      if (error || !data.session) return res.redirect("/login?oauth=failed");
      const { data: verified, error: verificationError } = await auth.getUser(data.session.access_token);
      const user = verified.user;
      if (verificationError || !user?.id || !user.identities?.some(identity => identity.provider === payload.provider)) {
        return res.redirect("/login?oauth=failed");
      }

      const openId = `supabase:${user.id}`;
      let account = await findUser(openId);
      if (!account) {
        const email = user.email_confirmed_at ? user.email ?? null : null;
        const displayName = user.user_metadata?.full_name ?? user.user_metadata?.name;
        const name = typeof displayName === "string" ? displayName.trim().slice(0, 150) : "";
        await saveUser({ openId, name: name || email?.split("@")[0] || "Clip Maker user", email, loginMethod: payload.provider });
        account = await findUser(openId);
      }
      if (!account) return res.redirect("/login?oauth=failed");
      await setSession(req, res, account, config.cookieOptions.secure);
      return res.redirect("/dashboard");
    } catch (error) {
      console.warn("[Supabase Auth] Could not complete sign-in", error.name);
      return res.redirect("/login?oauth=failed");
    }
  });
}
