import { createHash, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { parse } from "cookie";
import express from "express";
import { z } from "zod";
import { createSocialStore, tokenVault } from "./social-store.mjs";
import { createSocialProviders, publishingConfig, PublishingError, PLATFORMS } from "./social-providers.mjs";

const platformInput = z.enum(PLATFORMS);
const inputSchema = z.object({
  id: z.string().uuid(), clipId: z.number().int().positive(), platform: platformInput,
  title: z.string().trim().min(1).max(100).refine(value => !/[<>]/.test(value)),
  caption: z.string().max(2200), privacy: z.string().min(1).max(40),
  consent: z.literal(true), ownsContent: z.literal(true),
  madeForKids: z.boolean().optional(), aiGenerated: z.boolean().default(false),
  allowComments: z.boolean().default(false), allowDuet: z.boolean().default(false), allowStitch: z.boolean().default(false),
  brandedContent: z.boolean().default(false), ownBrand: z.boolean().default(false),
});
const visiblePost = post => ({ id: post.id, clipId: post.clip_id, platform: post.platform, status: post.status, url: post.url, error: post.error, createdAt: post.created_at });
const active = status => ["uploading", "processing", "checking"].includes(status);

export function registerSocialPublishing(app, dependencies, env = process.env) {
  const config = publishingConfig(env);
  const store = dependencies.store || createSocialStore(env);
  const providers = dependencies.providers || createSocialProviders(config);
  let vault;
  const secure = config.origin?.startsWith("https:");
  const cookieOptions = { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 10 * 60_000 };
  const cookieName = platform => `${secure ? "__Host-" : ""}clip-maker-social-${platform}`;
  const configured = platform => !!(config.origin && config.credentials[platform]?.every(Boolean) && env.JWT_SECRET?.length >= 32);
  const tokensVault = () => vault ||= tokenVault(env.JWT_SECRET);
  const owner = (user, platform) => `${user}:${platform}`;
  const route = handler => async (req, res, next) => {
    try { await handler(req, res, next); }
    catch (error) {
      const status = error instanceof PublishingError ? error.status : error instanceof z.ZodError ? 400 : 503;
      const message = error instanceof PublishingError ? error.message : error instanceof z.ZodError ? "Check your publishing options and consent before continuing." : "Publishing is temporarily unavailable. Please try again.";
      // Avoid provider response bodies, token URLs, and DB connection strings.
      console.warn(`[Publishing] Request failed (${status})`);
      if (!res.headersSent) res.status(status).json({ message });
    }
  };
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));
  router.use(route(async (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    const user = await dependencies.authenticate(req).catch(() => null);
    if (!user) return res.status(401).json({ message: "Sign in to connect accounts or publish clips." });
    req.socialUser = user;
    if (!["GET", "HEAD"].includes(req.method) && (!config.origin || req.get("origin") !== config.origin)) {
      return res.status(403).json({ message: "Open Clip Maker on its main website and try again." });
    }
    next();
  }));

  async function connection(user, platform) {
    if (!configured(platform)) throw new PublishingError("Publishing to this platform has not been enabled yet.", 503);
    return store.withAccountLock(user, platform, async client => {
      const account = await store.account(user, platform, client);
      if (!account) throw new PublishingError("Connect your account first.", 409);
      let tokens = tokensVault().open(account.tokens, owner(user, platform));
      const margin = platform === "instagram" ? 7 * 24 * 3600_000 : 120_000;
      if (tokens.expires_at < Date.now() + margin) {
        tokens = await providers.refresh(platform, tokens);
        await store.saveAccount(user, platform, { ...account, tokens: tokensVault().seal(tokens, owner(user, platform)) }, client);
      }
      return { account, token: tokens.access_token };
    });
  }

  async function checkPost(post) {
    const user = post.user_id;
    const { account, token } = await connection(user, post.platform).catch(async (error) => {
      await store.touchPost?.(post.id, user).catch(() => {});
      throw error;
    });
    if (account.external_id !== post.account_id) throw new PublishingError("Reconnect the account used for this post.", 409);
    if (!(await store.claimPost(post.id, user))) return;
    try {
      await store.updatePost(post.id, user, await providers.check(post.platform, token, account, post.remote));
    } catch {
      await store.updatePost(post.id, user, post.platform === "instagram"
        ? { status: "unknown", error: "Instagram’s reply was interrupted. Check your profile before posting again." }
        : { status: "processing", error: "The platform is taking longer to respond. Check status again shortly." });
    }
  }

  router.get("/accounts", route(async (req, res) => {
    const anyConfigured = PLATFORMS.some(configured);
    const accounts = anyConfigured ? await store.accounts(req.socialUser.id) : [];
    res.json({ platforms: PLATFORMS.map(platform => ({ platform, configured: configured(platform), account: accounts.find(a => a.platform === platform) || null })), tiktokPublicPosting: config.tiktokAudited });
  }));

  router.post("/connect/:platform", route(async (req, res) => {
    const platform = platformInput.parse(req.params.platform);
    if (!configured(platform)) throw new PublishingError("Publishing to this platform has not been enabled yet.", 503);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    await store.saveState(state, req.socialUser.id, platform, tokensVault().seal(verifier, owner(req.socialUser.id, platform)));
    res.cookie(cookieName(platform), state, cookieOptions);
    res.json({ url: providers.authorization(platform, state, createHash("sha256").update(verifier).digest("base64url")) });
  }));

  router.get("/callback/:platform", route(async (req, res) => {
    const platform = platformInput.parse(req.params.platform);
    const fail = () => res.redirect(303, "/dashboard/publish?connection=failed");
    const { state, code, error } = req.query;
    const cookie = parse(req.headers.cookie || "")[cookieName(platform)];
    res.clearCookie(cookieName(platform), { ...cookieOptions, maxAge: undefined });
    if (error || !configured(platform) || typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state) || cookie !== state || typeof code !== "string" || code.length > 2048) return fail();
    const record = await store.consumeState(state, req.socialUser.id, platform);
    if (!record) return fail();
    try {
      const busy = (await store.posts(req.socialUser.id)).some(p => p.platform === platform && active(p.status));
      if (busy) return res.redirect(303, "/dashboard/publish?connection=busy");
      const tokens = await providers.exchange(platform, code, tokensVault().open(record.verifier, owner(req.socialUser.id, platform)));
      const account = await providers.profile(platform, tokens.access_token);
      await store.saveAccount(req.socialUser.id, platform, { ...account, tokens: tokensVault().seal(tokens, owner(req.socialUser.id, platform)) });
      return res.redirect(303, "/dashboard/publish?connection=success");
    } catch { return fail(); }
  }));

  router.delete("/accounts/:platform", route(async (req, res) => {
    const platform = platformInput.parse(req.params.platform);
    if ((await store.posts(req.socialUser.id)).some(p => p.platform === platform && active(p.status))) throw new PublishingError("Wait for the current post to finish before disconnecting.", 409);
    const account = await store.account(req.socialUser.id, platform);
    let revoked = true;
    if (account) {
      try {
        const tokens = tokensVault().open(account.tokens, owner(req.socialUser.id, platform));
        await providers.revoke(platform, tokens);
      } catch { revoked = false; }
      await store.disconnect(req.socialUser.id, platform);
    }
    res.json({ disconnected: true, revoked });
  }));

  router.get("/creator/:platform", route(async (req, res) => {
    const platform = platformInput.parse(req.params.platform);
    const { token } = await connection(req.socialUser.id, platform);
    res.json({ creator: await providers.creator(platform, token) });
  }));

  router.get("/posts", route(async (req, res) => {
    res.json({ posts: PLATFORMS.some(configured) ? (await store.posts(req.socialUser.id)).map(visiblePost) : [] });
  }));

  router.post("/posts", route(async (req, res) => {
    const input = inputSchema.parse(req.body);
    const user = req.socialUser.id;
    if (input.platform === "youtube" && (!["private", "unlisted", "public"].includes(input.privacy) || typeof input.madeForKids !== "boolean")) throw new PublishingError("Choose YouTube visibility and whether this video is made for kids.");
    if (input.platform === "instagram" && input.privacy !== "public") throw new PublishingError("Instagram Reels are published to your professional account’s audience.");
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = await store.post(input.id, user);
    if (existing) {
      if (existing.request_hash !== hash) throw new PublishingError("This publishing request already has different settings. Start a new post.", 409);
      return res.json({ post: visiblePost(existing) });
    }
    const { account, token } = await connection(user, input.platform);
    const clip = await dependencies.getClip(input.clipId, user);
    if (!clip || clip.status !== "done" || !clip.downloadUrl) throw new PublishingError("Render this clip before publishing it.", 404);
    const path = await dependencies.getClipPath(clip);
    if (!path) throw new PublishingError("The rendered clip is unavailable. Render it again.", 409);
    const size = (await stat(path)).size;
    if (!size || size > 500 * 1024 * 1024) throw new PublishingError("Choose a clip smaller than 500 MB.");
    const { duration } = await dependencies.probeMedia(path);
    if (!(duration > 0)) throw new PublishingError("This clip could not be read. Render it again.");
    if (input.platform === "instagram" && (duration < 3 || duration > 900)) throw new PublishingError("Choose an Instagram Reel between 3 seconds and 15 minutes.");
    const publicUrl = input.platform === "instagram" ? await dependencies.getPublicClipUrl(clip) : null;
    if (input.platform === "instagram" && !publicUrl) throw new PublishingError("This clip could not be prepared for Instagram. Try rendering it again.", 409);
    const created = await store.createPost({ id: input.id, user_id: user, platform: input.platform, clip_id: input.clipId, account_id: account.external_id, request_hash: hash });
    if (!created) {
      const duplicate = await store.post(input.id, user);
      if (!duplicate || duplicate.request_hash !== hash) throw new PublishingError("This request already exists.", 409);
      return res.json({ post: visiblePost(duplicate) });
    }
    try {
      const result = await providers.upload(input.platform, token, account, { path, size, duration, publicUrl }, input);
      await store.updatePost(input.id, user, result);
    } catch (error) {
      // An interrupted response can follow a successful remote upload. Do not
      // auto-resubmit it and accidentally publish the same clip twice.
      await store.updatePost(input.id, user, { status: error instanceof PublishingError && error.status < 500 ? "failed" : "unknown", error: error instanceof PublishingError ? error.message : "The upload was interrupted. Check your social account before posting again." });
    }
    res.status(202).json({ post: visiblePost(await store.post(input.id, user)) });
  }));

  router.post("/posts/:id/refresh", route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const user = req.socialUser.id;
    const post = await store.post(id, user);
    if (!post) throw new PublishingError("Post not found.", 404);
    if (post.status !== "processing") return res.json({ post: visiblePost(post) });
    await checkPost(post);
    res.json({ post: visiblePost(await store.post(id, user)) });
  }));
  app.use("/api/social", router);
  let checking = false;
  // Jobs survive restarts. Atomic DB claims also make polling safe when the
  // browser and multiple web instances check the same post together.
  const timer = PLATFORMS.some(configured) && dependencies.background !== false ? setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      for (const post of await store.pendingPosts()) await checkPost(post).catch(() => {});
    } catch { console.warn("[Publishing] Could not check pending posts."); }
    finally { checking = false; }
  }, 15_000) : null;
  timer?.unref();
  return { store, stop: () => clearInterval(timer) };
}
