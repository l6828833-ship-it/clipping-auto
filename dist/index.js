// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
var OAUTH_STATE_COOKIE = "__Host-oauth_state";
var decodeOAuthState = (state) => {
  let decoded;
  try {
    decoded = atob(state);
  } catch {
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
  }
  return { redirectUri: decoded };
};

// server/_core/oauth.ts
import { parse as parseCookieHeader2 } from "cookie";

// server/db.ts
import { eq, desc, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

// drizzle/schema.ts
import { boolean, integer, jsonb, pgEnum, pgTable, real, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
var userRole = pgEnum("user_role", ["user", "admin"]);
var sourceType = pgEnum("source_type", ["upload", "url"]);
var videoStatus = pgEnum("video_status", ["pending", "transcribing", "analyzing", "done", "error"]);
var hostedStatus = pgEnum("hosted_status", ["none", "downloading", "ready", "error"]);
var clipStatus = pgEnum("clip_status", ["pending", "rendering", "done", "error"]);
var users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  passwordHash: varchar("passwordHash", { length: 255 }),
  role: userRole("role").default("user").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn", { withTimezone: true }).defaultNow().notNull()
});
var videos = pgTable("videos", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),
  title: varchar("title", { length: 512 }),
  sourceType: sourceType("sourceType").notNull(),
  sourceUrl: text("sourceUrl"),
  status: videoStatus("status").default("pending").notNull(),
  duration: real("duration"),
  transcript: text("transcript"),
  transcriptWords: jsonb("transcriptWords"),
  transcriptionEnabled: boolean("transcriptionEnabled").default(true).notNull(),
  sttCalls: integer("sttCalls").default(0).notNull(),
  sttSeconds: real("sttSeconds").default(0).notNull(),
  hostedStatus: hostedStatus("hostedStatus").default("none").notNull(),
  hostedUrl: text("hostedUrl"),
  hostProgress: integer("hostProgress").default(0).notNull(),
  hostedOffset: real("hostedOffset").default(0).notNull(),
  width: integer("width"),
  height: integer("height"),
  hostError: text("hostError"),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull()
});
var clips = pgTable("clips", {
  id: serial("id").primaryKey(),
  videoId: integer("videoId").notNull(),
  userId: integer("userId").notNull(),
  title: varchar("title", { length: 512 }),
  startTime: real("startTime"),
  endTime: real("endTime"),
  engagementScore: real("engagementScore"),
  status: clipStatus("status").default("pending").notNull(),
  downloadUrl: text("downloadUrl"),
  thumbnailUrl: text("thumbnailUrl"),
  errorMessage: text("errorMessage"),
  zoom: real("zoom").default(1).notNull(),
  offsetX: real("offsetX").default(0).notNull(),
  offsetY: real("offsetY").default(0).notNull(),
  captionsEnabled: boolean("captionsEnabled").default(true).notNull(),
  framingSegments: jsonb("framingSegments"),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull()
});
var subtitles = pgTable("subtitles", {
  id: serial("id").primaryKey(),
  clipId: integer("clipId").notNull(),
  userId: integer("userId").notNull(),
  words: jsonb("words"),
  style: jsonb("style"),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull()
});

// server/_core/env.ts
var ENV = {
  // Custom email/password auth runs without a Manus app ID in standalone deployments.
  // Keep a stable non-empty identifier because the session verifier requires one.
  appId: process.env.VITE_APP_ID || "shortspro-ai",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/db.ts
var _db = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function upsertUser(user) {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) {
      throw new Error("Database is not configured. Set DATABASE_URL to the Supabase PostgreSQL connection string.");
  }
  try {
    const values = {
      openId: user.openId
    };
    const updateSet = {};
    const textFields = ["name", "email", "loginMethod", "passwordHash"];
    const assignNullable = (field) => {
      const value = user[field];
      if (value === void 0) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== void 0) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== void 0) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = /* @__PURE__ */ new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = /* @__PURE__ */ new Date();
    }
    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.openId,
      set: updateSet
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}
async function getUserByOpenId(openId) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return void 0;
  }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
async function getUserByEmail(email) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
async function getUserById(id) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
async function updateUser(id, data) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set(data).where(eq(users.id, id));
}
async function createVideo(data) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(videos).values(data).returning({ id: videos.id });
  return result[0]?.id;
}
async function getVideosByUser(userId) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(videos).where(eq(videos.userId, userId)).orderBy(desc(videos.createdAt));
}
async function getVideoById(id, userId) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(videos).where(and(eq(videos.id, id), eq(videos.userId, userId))).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
async function updateVideo(id, data) {
  const db = await getDb();
  if (!db) return;
  await db.update(videos).set(data).where(eq(videos.id, id));
}
async function resetOrphanedJobs() {
  const db = await getDb();
  if (!db) return { videos: 0, clips: 0 };
  const stuckVideos = await db.select({ id: videos.id }).from(videos).where(eq(videos.hostedStatus, "downloading"));
  if (stuckVideos.length > 0) {
    await db.update(videos).set({
      hostedStatus: "none",
      hostProgress: 0,
      hostError: "The import was interrupted by a server restart. Try again."
    }).where(eq(videos.hostedStatus, "downloading"));
  }
  const stuckClips = await db.select({ id: clips.id }).from(clips).where(eq(clips.status, "rendering"));
  if (stuckClips.length > 0) {
    await db.update(clips).set({
      status: "error",
      errorMessage: "Rendering was interrupted by a server restart. Try again."
    }).where(eq(clips.status, "rendering"));
  }
  return { videos: stuckVideos.length, clips: stuckClips.length };
}
async function createClip(data) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const result = await db.insert(clips).values(data).returning({ id: clips.id });
  return result[0]?.id;
}
async function getClipsByUser(userId) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(clips).where(eq(clips.userId, userId)).orderBy(desc(clips.createdAt));
}
async function getClipsByVideo(videoId, userId) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(clips).where(and(eq(clips.videoId, videoId), eq(clips.userId, userId))).orderBy(desc(clips.createdAt));
}
async function updateClip(id, data) {
  const db = await getDb();
  if (!db) return;
  await db.update(clips).set(data).where(eq(clips.id, id));
}
async function getSubtitleByClip(clipId) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(subtitles).where(eq(subtitles.clipId, clipId)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
async function upsertSubtitle(data) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const existing = await getSubtitleByClip(data.clipId);
  if (existing) {
    await db.update(subtitles).set(data).where(eq(subtitles.clipId, data.clipId));
    return existing.id;
  } else {
    const result = await db.insert(subtitles).values(data).returning({ id: subtitles.id });
    return result[0]?.id;
  }
}
async function getClipById(id, userId) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(clips).where(and(eq(clips.id, id), eq(clips.userId, userId))).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
async function deleteClip(id) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subtitles).where(eq(subtitles.clipId, id));
  await db.delete(clips).where(eq(clips.id, id));
}
async function recordSttUsage(videoId, audioSeconds) {
  const db = await getDb();
  if (!db) return;
  await db.update(videos).set({
    sttCalls: sql`${videos.sttCalls} + 1`,
    sttSeconds: sql`${videos.sttSeconds} + ${Math.max(0, audioSeconds)}`
  }).where(eq(videos.id, videoId));
}

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  const secure = isSecureRequest(req);
  return {
    httpOnly: true,
    path: "/",
    sameSite: secure ? "none" : "lax",
    secure
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client) {
    this.client = client;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    return decodeOAuthState(state).redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    let sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken) {
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }
    const session = await this.verifySession(sessionToken);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
};
var CRON_OPEN_ID_PREFIX = "cron_";
function buildCronUser(userInfo) {
  const now = /* @__PURE__ */ new Date();
  return {
    id: -1,
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? void 0,
    isCron: true
  };
}
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app) {
  app.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    const { nonce } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader2(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/", secure: true, sameSite: "none" });
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/storageProxy.ts
function registerStorageProxy(app) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` }
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = await forgeResp.json();
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}

// server/_core/mediaRoutes.ts
import { createReadStream, promises as fs2 } from "fs";

// server/media.ts
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
var DATA_DIR = path.resolve(process.cwd(), ".data");
var VIDEOS_DIR = path.join(DATA_DIR, "videos");
var CLIPS_DIR = path.join(DATA_DIR, "clips");
var RENDER_TMP_DIR = path.join(DATA_DIR, "render");
var FONTS_DIR = path.resolve(process.cwd(), "assets", "fonts");
var MEDIA_URL_PREFIX = "/api/media";
var MEDIA_NAME = {
  video: /^video-\d+-[a-f0-9]{10}\.mp4$/,
  clip: /^clip-\d+-[a-f0-9]{10}\.mp4$/
};
function dirFor(kind) {
  return kind === "video" ? VIDEOS_DIR : CLIPS_DIR;
}
function urlFor(kind, fileName) {
  return `${MEDIA_URL_PREFIX}/${kind}/${fileName}`;
}
function shortHash(...parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10);
}
function videoFileName(videoId, sourceUrl) {
  return `video-${videoId}-${shortHash(sourceUrl)}.mp4`;
}
function clipFileName(clipId, sourceKey, start, end, zoom, offsetX, offsetY, barColor = "black") {
  return `clip-${clipId}-${shortHash(sourceKey, start, end, zoom, offsetX, offsetY, barColor)}.mp4`;
}
async function ensureDirs() {
  await fs.mkdir(VIDEOS_DIR, { recursive: true });
  await fs.mkdir(CLIPS_DIR, { recursive: true });
  await fs.mkdir(RENDER_TMP_DIR, { recursive: true });
}
function filterRelativePath(from, target) {
  return path.relative(from, target).split(path.sep).join("/");
}
function resolveMediaPath(kind, name) {
  if (!MEDIA_NAME[kind].test(name)) return null;
  const dir = dirFor(kind);
  const full = path.join(dir, name);
  if (path.relative(dir, full).startsWith("..")) return null;
  return full;
}
function localPathFromUrl(url) {
  if (!url) return null;
  const match = /^\/api\/media\/(video|clip)\/([^/?#]+)$/.exec(url);
  if (!match) return null;
  return resolveMediaPath(match[1], match[2]);
}

// server/_core/mediaRoutes.ts
var KINDS = /* @__PURE__ */ new Set(["video", "clip"]);
function registerMediaRoutes(app) {
  app.get("/api/media/:kind/:name", async (req, res) => {
    const kind = req.params.kind;
    if (!KINDS.has(kind)) {
      res.status(404).json({ error: "Unknown media kind" });
      return;
    }
    const filePath = resolveMediaPath(kind, req.params.name);
    if (!filePath) {
      res.status(400).json({ error: "Invalid media file name" });
      return;
    }
    let stat;
    try {
      stat = await fs2.stat(filePath);
    } catch {
      res.status(404).json({ error: "Media not available yet" });
      return;
    }
    const total = stat.size;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.name}"`);
    }
    const range = req.headers.range;
    if (!range) {
      res.setHeader("Content-Length", String(total));
      createReadStream(filePath).pipe(res);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
      return;
    }
    const [, startRaw, endRaw] = match;
    let start = startRaw ? Number(startRaw) : 0;
    let end = endRaw ? Number(endRaw) : total - 1;
    if (!startRaw && endRaw) {
      start = Math.max(0, total - Number(endRaw));
      end = total - 1;
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
      return;
    }
    end = Math.min(end, total - 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(filePath, { start, end }).pipe(res);
  });
}

// server/routers/extract.ts
import { z } from "zod";

// server/_core/trpc.ts
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/routers/extract.ts
import { TRPCError as TRPCError2 } from "@trpc/server";
import { promises as fs4 } from "fs";
import path3 from "path";
import os2 from "os";

// server/binaries.ts
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fs3 } from "fs";
import path2 from "path";
import os from "os";
var execAsync = promisify(exec);
async function globWingetBin(exeName) {
  if (process.platform !== "win32") return [];
  const root = path2.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
  const found = [];
  try {
    for (const pkg of await fs3.readdir(root)) {
      const pkgDir = path2.join(root, pkg);
      found.push(path2.join(pkgDir, "bin", exeName));
      try {
        for (const sub of await fs3.readdir(pkgDir)) {
          found.push(path2.join(pkgDir, sub, "bin", exeName));
        }
      } catch {
      }
    }
  } catch {
  }
  return found;
}
async function resolveBinary(name) {
  const isWin = process.platform === "win32";
  const exeName = isWin ? `${name}.exe` : name;
  try {
    const { stdout } = await execAsync(
      isWin ? `where ${name}` : `which ${name}`,
      { timeout: 5e3 }
    );
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first && path2.isAbsolute(first)) {
      try {
        await fs3.access(first);
        return first;
      } catch {
      }
    }
  } catch {
  }
  const home = os.homedir();
  const candidates = [
    // pip installs
    ...["313", "312", "311", "310", "39"].flatMap((v) => [
      path2.join(home, "AppData", "Local", "Programs", "Python", `Python${v}`, "Scripts", exeName),
      path2.join(home, "AppData", "Roaming", "Python", `Python${v}`, "Scripts", exeName)
    ]),
    path2.join(home, "scoop", "shims", exeName),
    path2.join("C:", "ProgramData", "chocolatey", "bin", exeName),
    path2.join("C:", "ffmpeg", "bin", exeName),
    path2.join("C:", name, "bin", exeName),
    ...await globWingetBin(exeName),
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/opt/homebrew/bin/${name}`
  ];
  for (const candidate of candidates) {
    try {
      await fs3.access(candidate);
      return candidate;
    } catch {
    }
  }
  return null;
}
var ytDlpPath;
var ffmpegPath;
async function findYtDlp() {
  if (ytDlpPath === void 0) ytDlpPath = await resolveBinary("yt-dlp");
  return ytDlpPath;
}
async function findFfmpeg() {
  if (ffmpegPath === void 0) ffmpegPath = await resolveBinary("ffmpeg");
  return ffmpegPath;
}
var YT_DLP_MISSING = "yt-dlp is not installed on the server. Install it with `pip install -U yt-dlp` and restart the dev server.";
/*
 * YouTube now serves the good formats only over SABR to the default clients,
 * which yt-dlp cannot read, leaving a single 360p muxed stream. The `mweb`
 * client still hands out normal DASH URLs, but only when the request carries a
 * PO Token, so a token provider has to be wired in for 1080p to appear at all.
 *
 * The provider script runs under its own Node because its jsdom dependency
 * needs require(ESM), which only landed in Node 22.12.
 */
var BGUTIL_NODE = process.env.BGUTIL_NODE ?? path3.join(os2.homedir(), "local", "node22", "bin", "node");
var BGUTIL_POT_SCRIPT = process.env.BGUTIL_POT_SCRIPT ?? path3.join(os2.homedir(), "local", "bgutil-server", "build", "generate_once.js");
var YT_CLIENT_ARGS = [
  "--js-runtimes",
  `node:${BGUTIL_NODE}`,
  "--extractor-args",
  `youtubepot-bgutilscript:script_path=${BGUTIL_POT_SCRIPT}`,
  "--extractor-args",
  "youtube:player_client=mweb"
];
var YT_CLIENT_ARGS_STR = [
  "--js-runtimes",
  q(`node:${BGUTIL_NODE}`),
  "--extractor-args",
  q(`youtubepot-bgutilscript:script_path=${BGUTIL_POT_SCRIPT}`),
  "--extractor-args",
  q("youtube:player_client=mweb")
].join(" ");
/* Public fallback clients used only after the default compatible source gets a
 * 403. They do not require a user cookie and are kept bounded to one retry. */
var YT_PUBLIC_FALLBACK_CLIENT_ARGS = [
  "--impersonate",
  "chrome",
  "--extractor-args",
  "youtube:player_client=web_embedded,web,tv"
];
/*
 * Cloud containers have no browser profile. Never try to read a local Chrome,
 * Brave, or Firefox cookie database. Private/restricted sources can optionally
 * use an explicitly mounted Netscape cookie file via YTDLP_COOKIE_FILE.
 */
var YTDLP_COOKIE_FILE = (process.env.YTDLP_COOKIE_FILE ?? "").trim();
var YTDLP_COOKIE_ARGS = YTDLP_COOKIE_FILE ? ["--cookies", YTDLP_COOKIE_FILE] : [];
var YTDLP_COOKIE_ARGS_STR = YTDLP_COOKIE_FILE ? `--cookies ${q(YTDLP_COOKIE_FILE)}` : "";
/*
 * Word-level timings.
 *
 * Inworld's synchronous STT returns the transcript but always an empty
 * `wordTimestamps`, so anything built from it can only estimate where each
 * word falls. faster-whisper reports a real start/end per word, which is what
 * caption timing actually needs, so it is used as the timing engine and
 * Inworld is kept as the fallback.
 */
var WHISPER_PYTHON = process.env.WHISPER_PYTHON ?? "python3";
var WHISPER_SCRIPT = process.env.WHISPER_SCRIPT ?? path3.join(process.cwd(), "scripts", "whisper_words.py");
var WHISPER_MODEL = process.env.WHISPER_MODEL ?? "base.en";
async function localWhisperWords(audioPath, language = "en") {
  const { stdout } = await execAsync(
    `${q(WHISPER_PYTHON)} ${q(WHISPER_SCRIPT)} ${q(audioPath)} ${q(language)} ${q(WHISPER_MODEL)}`,
    { timeout: 9e5, maxBuffer: 64 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout);
  const words = (Array.isArray(parsed.words) ? parsed.words : []).filter(
    (w) => w && typeof w.word === "string" && w.word.trim() && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start
  ).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }));
  return { text: typeof parsed.text === "string" ? parsed.text.trim() : "", words };
}
var FFMPEG_MISSING = "ffmpeg is not installed on the server. Install it with `winget install Gyan.FFmpeg` (or your package manager) and restart the dev server.";
function q(value) {
  return value.includes(" ") ? `"${value}"` : value;
}

// server/transcript.ts
function parseVttTimestamp(value) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (h ? Number(h) * 3600 : 0) + Number(mm) * 60 + Number(ss) + (ms ? Number(ms.padEnd(3, "0")) / 1e3 : 0);
}
function cleanCaptionText(raw) {
  return raw.replace(/<[^>]*>/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ").replace(/>>+/g, " ").replace(/(^|\s)-{1,2}(\s|$)/g, " ").replace(/[\u266A\u266B\u266C\u2669\u25AA\u25CF]/g, " ").replace(/\*{2,}/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim();
}
function splitWords(text2) {
  return cleanCaptionText(text2).split(/\s+/).filter((w) => w && !/^>>+$/.test(w));
}
function parseInlineWordTimings(body, cueStart, cueEnd) {
  const tagRe = /<(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})>/g;
  if (!tagRe.test(body)) return null;
  tagRe.lastIndex = 0;
  const chunks = [];
  let cursor = 0;
  let match;
  while ((match = tagRe.exec(body)) !== null) {
    chunks.push({ time: null, text: body.slice(cursor, match.index) });
    const t2 = parseVttTimestamp(match[1]);
    chunks.push({ time: t2, text: "" });
    cursor = match.index + match[0].length;
  }
  chunks.push({ time: null, text: body.slice(cursor) });
  const out = [];
  let currentTime = cueStart;
  for (const chunk of chunks) {
    if (chunk.time != null) {
      currentTime = chunk.time;
      continue;
    }
    for (const word of splitWords(chunk.text)) {
      out.push({ word, start: currentTime, end: currentTime });
    }
  }
  if (out.length === 0) return null;
  for (let i = 0; i < out.length; i++) {
    const nextStart = i + 1 < out.length ? out[i + 1].start : cueEnd;
    out[i].end = Math.max(out[i].start + 0.08, nextStart);
  }
  return out;
}
function parseVtt(vtt) {
  const lines = vtt.split(/\r\n|\r|\n/);
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i].indexOf("-->");
    if (arrow === -1) continue;
    const start = parseVttTimestamp(lines[i].slice(0, arrow));
    const endPart = lines[i].slice(arrow + 3).trim().split(/\s+/)[0];
    const end = parseVttTimestamp(endPart ?? "");
    if (start == null || end == null || end <= start) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) {
      if (lines[j].includes("-->")) break;
      body.push(lines[j]);
    }
    const rawBody = body.join(" ");
    const words = parseInlineWordTimings(rawBody, start, end);
    const text2 = cleanCaptionText(rawBody);
    if (!text2) continue;
    cues.push({
      start,
      end,
      text: text2,
      words: words ?? distributeWords(splitWords(rawBody), start, end)
    });
  }
  return dedupeRollingCues(cues);
}
function distributeWords(words, start, end) {
  if (words.length === 0) return [];
  const span = Math.max(0.01, end - start);
  const weights = words.map((w) => Math.max(2, w.length));
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = start;
  return words.map((word, i) => {
    const width = weights[i] / total * span;
    const wordStart = cursor;
    cursor += width;
    return { word, start: wordStart, end: Math.min(end, cursor) };
  });
}
function dedupeRollingCues(cues) {
  const out = [];
  let lastWordStart = -Infinity;
  for (const cue of cues) {
    const fresh = cue.words.filter((w) => w.start > lastWordStart + 1e-3);
    if (fresh.length === 0) continue;
    lastWordStart = fresh[fresh.length - 1].start;
    out.push({ ...cue, words: fresh, text: fresh.map((w) => w.word).join(" ") });
  }
  return out;
}
function cuesToWords(cues) {
  return cues.flatMap((c) => c.words);
}
function cuesToText(cues) {
  return cues.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
}

// server/routers/extract.ts
async function getYtDlp() {
  const found = await findYtDlp();
  if (!found) throw new TRPCError2({ code: "PRECONDITION_FAILED", message: YT_DLP_MISSING });
  return found;
}
var getFfmpeg = findFfmpeg;
async function tryYouTubeTranscript(url, language = "en", tmpDir) {
  try {
    /* Use youtube-transcript package — doesn't need PO token or cookies */
    const { YoutubeTranscript } = await import("youtube-transcript");
    const videoIdMatch = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/v\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) return null;
    const videoId = videoIdMatch[1];
    const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: language }).catch(() => null);
    if (!segments || segments.length < 3) return null;
    const words = [];
    const textParts = [];
    for (const seg of segments) {
      const text = (seg.text || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
      if (!text) continue;
      textParts.push(text);
      const start = (seg.offset || 0) / 1000;
      const end = start + (seg.duration || 0) / 1000;
      if (end <= start) continue;
      for (const w of distributeWords(splitWords(text), start, end)) words.push(w);
    }
    const fullText = textParts.join(" ").replace(/\s+/g, " ").trim();
    if (fullText.length < 10) return null;
    console.log(`[Extract] youtube-transcript fetched ${segments.length} segments, ${words.length} timed words`);
    return { text: fullText, words };
  } catch (err) {
    console.warn(`[Extract] youtube-transcript failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
async function inworldTranscribe(audioPath, apiKey, language = "en") {
  const audioBytes = await fs4.readFile(audioPath);
  const audioB64 = audioBytes.toString("base64");
  const payload = {
    transcribeConfig: {
      modelId: "groq/whisper-large-v3",
      language,
      audioEncoding: "MP3"
    },
    audioData: { content: audioB64 }
  };
  const res = await fetch("https://api.inworld.ai/stt/v1/transcribe", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Inworld STT error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`STT error: ${data.error.message}`);
  return data.transcription?.transcript ?? "";
}
async function getVideoInfo(url) {
  const ytDlp = await getYtDlp();
  const { stdout } = await execAsync(
    `${q(ytDlp)} --no-playlist ${YT_CLIENT_ARGS_STR} --print-json --skip-download --no-warnings "${url}"`,
    { timeout: 6e4, maxBuffer: 20 * 1024 * 1024 }
  );
  const info = JSON.parse(stdout.trim());
  return {
    title: info.title ?? "Untitled",
    duration: info.duration ?? 0,
    uploader: info.uploader ?? "Unknown",
    thumbnail: info.thumbnail ?? "",
    description: info.description ?? ""
  };
}
async function whisperTranscribe(url, apiKey, language, tmpDir) {
  const ytDlp = await getYtDlp();
  const ffmpeg = await getFfmpeg();
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg is not installed on the server, which is required for Whisper transcription."
    );
  }
  const audioPath = path3.join(tmpDir, "audio.mp3");
  const downloadCmd = [
    q(ytDlp),
    "--no-playlist", YTDLP_COOKIE_ARGS_STR,
    YT_CLIENT_ARGS_STR,
    "--no-warnings",
    "-x",
    "--audio-format mp3",
    "--audio-quality 5",
    `--ffmpeg-location "${path3.dirname(ffmpeg)}"`,
    `-o "${audioPath}"`,
    `"${url}"`
  ].join(" ");
  await execAsync(downloadCmd, { timeout: 3e5 });
  const reencoded = path3.join(tmpDir, "audio_16k.mp3");
  await execAsync(
    `${q(ffmpeg)} -i "${audioPath}" -ar 16000 -ac 1 -b:a 64k "${reencoded}" -y -loglevel error`,
    { timeout: 12e4 }
  );
  /*
   * Inworld's synchronous STT models return the transcript text but leave
   * `wordTimestamps` empty, so there are no real per-word timings to use.
   *
   * Splitting on silence recovers most of that accuracy. Each speech run is
   * transcribed on its own, so its words are only spread across the time
   * someone is actually talking. Silent stretches produce no segment at all,
   * which keeps captions off the screen while nobody is speaking.
   */
  const MAX_SEGMENT_SECONDS = 30;
  const MIN_SPEECH_SECONDS = 0.25;
  const MERGE_GAP_SECONDS = 0.8;
  const runFfmpeg = async (args, timeout) => {
    const res = await execAsync(`${q(ffmpeg)} ${args} 2>&1`, {
      timeout,
      maxBuffer: 32 * 1024 * 1024
    }).catch((e) => ({ stdout: e?.stdout ?? "", stderr: e?.stderr ?? "" }));
    return `${res.stdout ?? ""}${res.stderr ?? ""}`;
  };
  const parseDuration = (blob) => {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(blob);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  };
  /* One pass gives both the duration and the silence map. */
  const analysis = await runFfmpeg(
    `-i ${q(reencoded)} -af "silencedetect=noise=-30dB:d=0.35" -f null -`,
    6e5
  );
  const totalDuration = parseDuration(analysis);
  const silenceStarts = [];
  const silenceEnds = [];
  for (const line of analysis.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (s) silenceStarts.push(Math.max(0, Number(s[1])));
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (e) silenceEnds.push(Math.max(0, Number(e[1])));
  }
  const limit = totalDuration > 0 ? totalDuration : Infinity;
  const silences = silenceStarts.map((start, i) => ({ start, end: silenceEnds[i] ?? limit })).filter((s) => s.end > s.start);
  /* Speech is whatever the silence map leaves behind. */
  const rawSpeech = [];
  let cursor = 0;
  for (const sil of silences) {
    if (sil.start > cursor) rawSpeech.push({ start: cursor, end: Math.min(sil.start, limit) });
    cursor = Math.max(cursor, sil.end);
  }
  if (totalDuration > 0 && cursor < totalDuration) {
    rawSpeech.push({ start: cursor, end: totalDuration });
  } else if (totalDuration === 0 && rawSpeech.length === 0) {
    rawSpeech.push({ start: 0, end: 0 });
  }
  /* Stitch runs split by a short breath back together, drop the slivers. */
  const merged = [];
  for (const sp of rawSpeech) {
    if (sp.end - sp.start < MIN_SPEECH_SECONDS) continue;
    const last = merged[merged.length - 1];
    if (last && sp.start - last.end < MERGE_GAP_SECONDS) last.end = sp.end;
    else merged.push({ start: sp.start, end: sp.end });
  }
  /* Keep every request inside the model's comfortable window. */
  const segments = [];
  for (const run of merged) {
    const span = run.end - run.start;
    if (span <= MAX_SEGMENT_SECONDS) {
      segments.push(run);
      continue;
    }
    const parts = Math.ceil(span / MAX_SEGMENT_SECONDS);
    const width = span / parts;
    for (let i = 0; i < parts; i++) {
      segments.push({
        start: run.start + i * width,
        end: i === parts - 1 ? run.end : run.start + (i + 1) * width
      });
    }
  }
  if (segments.length === 0) {
    const only = cleanCaptionText(await inworldTranscribe(reencoded, apiKey, language));
    return { text: only, words: [] };
  }
  const segDir = path3.join(tmpDir, "segments");
  await fs4.mkdir(segDir, { recursive: true });
  const results = new Array(segments.length).fill("");
  const CONCURRENCY = 4;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= segments.length) return;
      const seg = segments[i];
      const segPath = path3.join(segDir, `seg_${String(i).padStart(4, "0")}.mp3`);
      try {
        await execAsync(
          `${q(ffmpeg)} -ss ${seg.start.toFixed(3)} -t ${(seg.end - seg.start).toFixed(3)} -i ${q(reencoded)} -ar 16000 -ac 1 -b:a 64k ${q(segPath)} -y -loglevel error`,
          { timeout: 12e4 }
        );
        results[i] = await inworldTranscribe(segPath, apiKey, language);
      } catch (err) {
        console.warn(
          `[STT] Segment ${i + 1}/${segments.length} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        results[i] = "";
      } finally {
        await fs4.rm(segPath, { force: true }).catch(() => {
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, segments.length) }, () => worker())
  );
  const words = [];
  const textParts = [];
  for (let i = 0; i < results.length; i++) {
    const clean = cleanCaptionText(results[i]);
    if (!clean) continue;
    const seg = segments[i];
    if (seg.end <= seg.start) continue;
    textParts.push(clean);
    for (const w of distributeWords(splitWords(clean), seg.start, seg.end)) words.push(w);
  }
  const spokenSeconds = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  console.log(
    `[STT] ${segments.length} speech segment(s) covering ${spokenSeconds.toFixed(1)}s of ${totalDuration.toFixed(1)}s \u2192 ${words.length} words timed to speech`
  );
  return { text: textParts.join(" ").replace(/\s+/g, " ").trim(), words };
}
var extractRouter = router({
  /**
   * POST /api/trpc/extract.videoInfo
   * Returns metadata for a video URL without downloading it.
   */
  videoInfo: protectedProcedure.input(z.object({ url: z.string().url("Invalid URL") })).mutation(async ({ input }) => {
    try {
      const info = await getVideoInfo(input.url);
      return { success: true, ...info };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TRPCError2({ code: "BAD_REQUEST", message: `Could not fetch video info: ${msg}` });
    }
  }),
  /**
   * POST /api/trpc/extract.transcribe
   *
   * Strategy:
   *  1. Try to get YouTube's existing transcript (manual or auto-generated subtitles)
   *  2. If no transcript found, fall back to downloading audio + Inworld Whisper STT
   *
   * No duration limit — YouTube transcripts work for any length,
   * and Whisper splits long audio into chunks automatically.
   */
  transcribe: protectedProcedure.input(z.object({
    url: z.string().url("Invalid URL"),
    // Optional: without a key we simply skip the Whisper fallback.
    apiKey: z.string().optional(),
    language: z.string().default("en"),
    /**
     * When false, no speech-to-text is attempted at all — not even the
     * fallback. Used by the "subtitles off" import path so no Inworld credits
     * are spent.
     */
    allowSpeechToText: z.boolean().default(true)
  })).mutation(async ({ input }) => {
    const tmpDir = await fs4.mkdtemp(path3.join(os2.tmpdir(), "shortspro-"));
    try {
      let title = "Untitled", duration = 0, uploader = "";
      try {
        const info = await getVideoInfo(input.url);
        title = info.title;
        duration = info.duration;
        uploader = info.uploader;
      } catch (err) {
        if (err instanceof TRPCError2) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/unsupported url|is not a valid url|unable to download webpage/i.test(msg)) {
          throw new TRPCError2({
            code: "BAD_REQUEST",
            message: "Could not process this URL. Make sure it is a public YouTube, Vimeo, or direct video link."
          });
        }
      }
      console.log(`[Extract] Looking for an existing transcript: ${title}`);
      const ytTranscript = await tryYouTubeTranscript(input.url, input.language, tmpDir);
      if (ytTranscript) {
        console.log(
          `[Extract] Using existing captions (${ytTranscript.words.length} timed words)`
        );
        return {
          success: true,
          transcript: ytTranscript.text,
          // Real timings from the caption track, so burned-in subtitles
          // follow the speech instead of being spread evenly.
          words: ytTranscript.words,
          title,
          duration,
          uploader,
          wordCount: ytTranscript.words.length,
          source: "youtube",
          note: ""
        };
      }

      if (!input.allowSpeechToText) {
        console.log("[Extract] Speech-to-text disabled for this import \u2014 no STT call made.");
        return {
          success: true,
          transcript: "",
          words: [],
          title,
          duration,
          uploader,
          wordCount: 0,
          source: "none",
          note: "Subtitles are off for this import, so no transcript was generated."
        };
      }
      if (!input.apiKey || input.apiKey === "server") {
        const envKey = process.env.INWORLD_API_KEY;
        if (envKey) {
          input.apiKey = envKey;
        } else {
        console.log("[Extract] No transcript available and no Inworld key set \u2014 continuing without one.");
        return {
          success: true,
          transcript: "",
          words: [],
          title,
          duration,
          uploader,
          wordCount: 0,
          source: "none",
          note: "This video has no captions. Add an Inworld API key to auto-transcribe with Whisper, or paste a transcript manually."
        };
        }
      }
      console.log("[Extract] No existing transcript \u2014 skipping full-video STT to save costs. Clips will be individually transcribed.");
      return {
        success: true,
        transcript: "",
        words: [],
        title,
        duration,
        uploader,
        wordCount: 0,
        source: "none",
        note: "No YouTube captions found. AI highlights will use video info. Individual clips will be transcribed on render for subtitles."
      };
    } catch (err) {
      if (err instanceof TRPCError2) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/unsupported url|is not a valid url/i.test(msg)) {
        throw new TRPCError2({ code: "BAD_REQUEST", message: "Could not process this URL. Make sure it is a public YouTube, Vimeo, or direct video link." });
      }
      throw new TRPCError2({ code: "INTERNAL_SERVER_ERROR", message: `Extraction failed: ${msg}` });
    } finally {
      await fs4.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      });
    }
  }),
  /**
   * POST /api/trpc/extract.uploadTranscribe
   * Accepts a base64-encoded audio/video file, extracts audio with ffmpeg,
   * and transcribes it using Inworld STT.
   * Supports chunking for files longer than ~30 min.
   */
  uploadTranscribe: protectedProcedure.input(z.object({
    fileBase64: z.string().min(1),
    fileName: z.string(),
    apiKey: z.string().min(1, "Inworld API key is required"),
    language: z.string().default("en")
  })).mutation(async ({ input }) => {
    const tmpDir = await fs4.mkdtemp(path3.join(os2.tmpdir(), "shortspro-upload-"));
    const ext = path3.extname(input.fileName).toLowerCase() || ".mp4";
    const inputPath = path3.join(tmpDir, `input${ext}`);
    const audioPath = path3.join(tmpDir, "audio_16k.mp3");
    try {
      const ffmpeg = await getFfmpeg();
      if (!ffmpeg) {
        throw new TRPCError2({ code: "PRECONDITION_FAILED", message: FFMPEG_MISSING });
      }
      const fileBuffer = Buffer.from(input.fileBase64, "base64");
      await fs4.writeFile(inputPath, fileBuffer);
      await execAsync(
        `${q(ffmpeg)} -i "${inputPath}" -ar 16000 -ac 1 -b:a 64k "${audioPath}" -y -loglevel error`,
        { timeout: 12e4 }
      );
      const stat = await fs4.stat(audioPath);
      const fileSizeMB = stat.size / (1024 * 1024);
      let transcript = "";
      if (fileSizeMB <= 15) {
        transcript = await inworldTranscribe(audioPath, input.apiKey, input.language);
      } else {
        const chunkDir = path3.join(tmpDir, "chunks");
        await fs4.mkdir(chunkDir);
        const chunkPattern = path3.join(chunkDir, "chunk_%03d.mp3");
        await execAsync(
          `${q(ffmpeg)} -i "${audioPath}" -f segment -segment_time 900 -c copy "${chunkPattern}" -loglevel error`,
          { timeout: 12e4 }
        );
        const chunks = (await fs4.readdir(chunkDir)).filter((f) => f.endsWith(".mp3")).sort();
        const parts = [];
        for (const chunk of chunks) {
          const chunkPath = path3.join(chunkDir, chunk);
          const part = await inworldTranscribe(chunkPath, input.apiKey, input.language);
          parts.push(part);
        }
        transcript = parts.join(" ");
      }
      return {
        success: true,
        transcript: transcript.trim(),
        wordCount: transcript.trim().split(/\s+/).length,
        source: "whisper"
      };
    } finally {
      await fs4.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      });
    }
  })
});

// server/routers/gemini.ts
import { z as z2 } from "zod";
import { TRPCError as TRPCError3 } from "@trpc/server";

// server/inworld.ts
var INWORLD_BASE_URL = "https://api.inworld.ai";
async function inworldChat(opts) {
  const res = await fetch(`${INWORLD_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${opts.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 2048,
      ...opts.response_format ? { response_format: opts.response_format } : {}
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Inworld API error ${res.status}: ${errText}`);
  }
  return res.json();
}
function isUnsupportedModelError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /not supported|unknown model|invalid model|model not found|InvalidArgument/i.test(msg);
}
async function inworldChatResilient(opts) {
  try {
    const response = await inworldChat(opts);
    return { response, modelUsed: response.model || opts.model, substituted: false };
  } catch (err) {
    if (!isUnsupportedModelError(err)) throw err;
    let available = [];
    try {
      available = (await inworldListModels(opts.apiKey)).map((m) => m.id);
    } catch {
    }
    const requestedFamily = opts.model.split("/")[0];
    const alternatives = [
      // Prefer a live model from the same provider family.
      ...available.filter((id) => id.startsWith(`${requestedFamily}/`)),
      // Then anything else the key can see.
      ...available,
      // Last resort: let the router choose.
      "auto"
    ].filter((id) => id !== opts.model);
    const tried = /* @__PURE__ */ new Set([opts.model]);
    for (const candidate of alternatives) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      try {
        const response = await inworldChat({ ...opts, model: candidate });
        return { response, modelUsed: response.model || candidate, substituted: true };
      } catch (retryErr) {
        if (!isUnsupportedModelError(retryErr)) throw retryErr;
      }
    }
    throw err;
  }
}
async function inworldListModels(apiKey) {
  const res = await fetch(`${INWORLD_BASE_URL}/v1/models`, {
    headers: { "Authorization": `Basic ${apiKey}` }
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Inworld models error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.data ?? [];
}
function inworldGetContent(response) {
  return response.choices?.[0]?.message?.content ?? "";
}
function inworldWasTruncated(response) {
  const reason = response.choices?.[0]?.finish_reason;
  return reason === "length" || reason === "max_tokens";
}
function extractJsonBlock(text2) {
  const startObj = text2.indexOf("{");
  const startArr = text2.indexOf("[");
  const candidates = [startObj, startArr].filter((i) => i !== -1);
  if (candidates.length === 0) return null;
  const start = Math.min(...candidates);
  return text2.slice(start);
}
function repairTruncatedJson(input) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length > 0) lastSafe = i;
      continue;
    }
    if (ch === ",") {
      if (stack.length > 0) lastSafe = i - 1;
      continue;
    }
  }
  if (!inString && stack.length === 0) return input;
  let out = lastSafe >= 0 ? input.slice(0, lastSafe + 1) : input;
  const open = [];
  let s = false;
  let esc = false;
  for (const ch of out) {
    if (s) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') s = false;
      continue;
    }
    if (ch === '"') s = true;
    else if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") open.pop();
  }
  if (s) out += '"';
  out = out.replace(/,\s*$/, "");
  while (open.length > 0) out += open.pop() === "{" ? "}" : "]";
  return out;
}
function inworldParseJSON(response) {
  const raw = inworldGetContent(response).trim();
  if (!raw) {
    throw new Error("The model returned an empty response. Try again or pick a different model.");
  }
  let content = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(content);
  } catch {
  }
  const block = extractJsonBlock(content);
  if (block) {
    try {
      return JSON.parse(block);
    } catch {
    }
    try {
      return JSON.parse(repairTruncatedJson(block));
    } catch {
    }
  }
  const hint = inworldWasTruncated(response) ? "The response hit the token limit and was cut off. Try a shorter transcript." : "The model did not return valid JSON.";
  throw new Error(`${hint} Raw output started with: ${raw.slice(0, 120)}`);
}

// server/routers/gemini.ts
var INWORLD_GEMINI_MODELS = [
  "google-ai-studio/gemini-3.1-pro-preview",
  "google-ai-studio/gemini-3-flash-preview",
  "google-ai-studio/gemini-2.5-pro",
  "google-ai-studio/gemini-2.5-flash"
];
var INWORLD_POPULAR_MODELS = [
  ...INWORLD_GEMINI_MODELS,
  "openai/gpt-4o",
  "openai/gpt-5.2",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-6",
  "auto"
];
var HighlightSchema = z2.object({
  id: z2.number(),
  title: z2.string(),
  startTime: z2.number(),
  endTime: z2.number(),
  engagementScore: z2.number(),
  reason: z2.string()
});
var geminiRouter = router({
  /**
   * GET /api/trpc/gemini.models
   * Lists all available models from the Inworld AI Router.
   * Falls back to a curated list if no API key is provided.
   */
  models: publicProcedure.input(z2.object({ apiKey: z2.string().optional() })).query(async ({ input }) => {
    const resolvedKey = input.apiKey && input.apiKey !== "server" ? input.apiKey : process.env.INWORLD_API_KEY;
    if (!resolvedKey) {
      return INWORLD_POPULAR_MODELS.map((id) => ({ id, provider: id.split("/")[0] ?? "inworld" }));
    }
    try {
      const models = await inworldListModels(resolvedKey);
      return models.map((m) => ({
        id: m.id,
        provider: m.id.includes("/") ? m.id.split("/")[0] : "inworld"
      }));
    } catch {
      return INWORLD_POPULAR_MODELS.map((id) => ({ id, provider: id.split("/")[0] ?? "inworld" }));
    }
  }),
  /**
   * POST /api/trpc/gemini.detectHighlights
   * Sends a video transcript to the selected Inworld model (default: Gemini)
   * and returns the top 5 most viral/engaging clip suggestions.
   */
  detectHighlights: protectedProcedure.input(z2.object({
    transcript: z2.string().min(10, "Transcript is too short"),
    videoDuration: z2.number().optional(),
    model: z2.string().default("google-ai-studio/gemini-3-flash-preview"),
    apiKey: z2.string().min(1, "Inworld API key is required"),
    /** Pick candidates for one ranked source instead of five moments from one video. */
    rankingMode: z2.boolean().default(false),
    rank: z2.number().int().min(1).max(99).optional(),
    sourceTitle: z2.string().max(200).optional()
  })).mutation(async ({ input }) => {
    const defaultSystemPrompt = `You are an expert viral video editor and content strategist specializing in short-form content for TikTok, YouTube Shorts, and Instagram Reels.

Analyze the transcript and identify the TOP 5 most viral and engaging moments that would make excellent short clips (15-60 seconds each).

For each highlight, evaluate:
- Hook strength (does it grab attention in the first 3 seconds?)
- Emotional resonance (surprise, laughter, inspiration, shock)
- Information density (clear insight or punchline)
- Shareability
- Audio energy and pacing

Return ONLY valid JSON \u2014 no markdown, no code fences, no extra text.`;
    const defaultUserPrompt = `Analyze this transcript and identify the 5 best moments for viral short-form clips.

TRANSCRIPT:
${input.transcript}
${input.videoDuration ? `
Total video duration: ${Math.floor(input.videoDuration / 60)}m ${Math.floor(input.videoDuration % 60)}s` : ""}

Return this exact JSON structure:
{
  "highlights": [
    {
      "id": 1,
      "title": "SHORT CATCHY TITLE IN CAPS (max 8 words)",
      "startTime": <integer seconds>,
      "endTime": <integer seconds, VARY lengths: some 15-25s, some 25-40s, some 40-60s>,
      "engagementScore": <integer 60-99>,
      "reason": "One sentence explaining viral potential"
    }
  ],
  "reelTitle": "TOP 5 REEL TITLE IN ALL CAPS"
}

Rules: exactly 5 highlights sorted by engagementScore desc, IDs 1-5. IMPORTANT RULES:
1. SPREAD clips across the ENTIRE video — pick moments from the beginning, middle, AND end. Do NOT cluster all clips in the first few minutes.
2. Vary durations: mix short (15-25s), medium (25-40s), and long (40-60s). Do NOT make all clips the same length.
3. Each startTime must be at least 30 seconds apart from any other clip's startTime.
4. If the video is longer than 10 minutes, at least 2 clips MUST come from the second half.`;
    const rankingMode = input.rankingMode === true;
    const rank = input.rank ?? 1;
    const systemPrompt = rankingMode
      ? `You are an expert short-form ranking editor. Select the strongest self-contained video moments from ONE source for a ranked countdown reel. The selected moment must make sense without the surrounding video, open with a clear hook, and end on a payoff. Generate clean, short, all-caps display titles. Return only valid JSON.`
      : defaultSystemPrompt;
    const userPrompt = rankingMode
      ? `Choose the best 3 candidate clips from this source for rank #${rank} in a multi-source countdown. Source title: ${input.sourceTitle || "Untitled source"}. Each candidate must be 8-15 seconds, have a strong opening and a complete payoff. Do not repeat or overlap candidates.

TRANSCRIPT:
${input.transcript}
${input.videoDuration ? `\nTotal video duration: ${Math.floor(input.videoDuration / 60)}m ${Math.floor(input.videoDuration % 60)}s` : ""}

Return exactly this JSON:
{
  "highlights": [
    {
      "id": 1,
      "title": "SHORT ALL-CAPS TITLE, MAX 8 WORDS",
      "startTime": <integer seconds>,
      "endTime": <integer seconds>,
      "engagementScore": <integer 60-99>,
      "reason": "One sentence explaining why this works at rank #${rank}"
    }
  ],
  "reelTitle": "A SHORT ALL-CAPS LABEL FOR THIS RANK"
}
Rules: return exactly 3 highlights sorted from strongest to weakest. Every endTime must be no more than 15 seconds after its startTime.`
      : defaultUserPrompt;
    try {
      const { response, modelUsed, substituted } = await inworldChatResilient({
        model: input.model,
        apiKey: (input.apiKey && input.apiKey !== "server" ? input.apiKey : process.env.INWORLD_API_KEY || input.apiKey),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.7,
        // Headroom so 5 highlights are never cut off mid-object.
        max_tokens: 4096
      });
      if (substituted) {
        console.warn(`[Inworld] "${input.model}" is unavailable \u2014 used "${modelUsed}" instead.`);
      }
      const parsed = inworldParseJSON(response);
      const highlights = [];
      for (const item of parsed.highlights ?? []) {
        const result = HighlightSchema.safeParse(item);
        if (result.success) highlights.push(result.data);
      }
      if (highlights.length === 0) {
        throw new TRPCError3({
          code: "INTERNAL_SERVER_ERROR",
          message: "The model did not return any usable highlights. Try again or pick a different model."
        });
      }
      const ordered = highlights.sort((a, b) => b.engagementScore - a.engagementScore).map((h, i) => ({ ...h, id: i + 1 }));
      return {
        highlights: ordered,
        reelTitle: parsed.reelTitle?.trim() || (rankingMode ? `RANK ${rank}` : "TOP MOMENTS"),
        modelUsed,
        modelSubstituted: substituted,
        metadata: response.metadata
      };
    } catch (err) {
      console.error("[Inworld] detectHighlights error:", err);
      if (err instanceof TRPCError3) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: `AI analysis failed: ${msg}` });
    }
  }),
  /**
   * POST /api/trpc/gemini.generateTitle
   * Generates a viral hook title, first-sentence hook, and hashtags for a clip.
   */
  generateTitle: protectedProcedure.input(z2.object({
    clipContent: z2.string().min(5),
    style: z2.enum(["tiktok", "youtube", "instagram"]).default("tiktok"),
    model: z2.string().default("google-ai-studio/gemini-3-flash-preview"),
    apiKey: z2.string().min(1, "Inworld API key is required")
  })).mutation(async ({ input }) => {
    try {
      const { response, modelUsed } = await inworldChatResilient({
        model: input.model,
        apiKey: (input.apiKey && input.apiKey !== "server" ? input.apiKey : process.env.INWORLD_API_KEY || input.apiKey),
        messages: [
          {
            role: "system",
            content: `You are a viral content strategist writing irresistible hooks for ${input.style} short-form videos. Titles are bold, capitalized, and maximize CTR and shares. Return ONLY JSON, no markdown.`
          },
          {
            role: "user",
            content: `Generate a viral hook title and 3 hashtags for this clip:

"${input.clipContent}"

Return: { "title": "HOOK TITLE IN CAPS", "hook": "First sentence hook max 15 words", "hashtags": ["tag1", "tag2", "tag3"] }`
          }
        ],
        temperature: 0.8,
        max_tokens: 1024
      });
      const parsed = inworldParseJSON(response);
      return z2.object({
        title: z2.string(),
        hook: z2.string(),
        hashtags: z2.array(z2.string()),
        modelUsed: z2.string().optional()
      }).parse({ ...parsed, modelUsed });
    } catch (err) {
      if (err instanceof TRPCError3) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: `Title generation failed: ${msg}` });
    }
  }),
  /**
   * POST /api/trpc/gemini.analyzeTranscript
   * Analyzes a transcript and returns summary, category, key topics, sentiment.
   */
  analyzeTranscript: protectedProcedure.input(z2.object({
    transcript: z2.string().min(10),
    model: z2.string().default("google-ai-studio/gemini-3-flash-preview"),
    apiKey: z2.string().min(1, "Inworld API key is required")
  })).mutation(async ({ input }) => {
    try {
      const { response, modelUsed } = await inworldChatResilient({
        model: input.model,
        apiKey: (input.apiKey && input.apiKey !== "server" ? input.apiKey : process.env.INWORLD_API_KEY || input.apiKey),
        messages: [
          { role: "system", content: "You are a content analyst. Return ONLY JSON, no markdown." },
          {
            role: "user",
            content: `Analyze this transcript:

"${input.transcript.slice(0, 3e3)}"

Return: { "summary": "2-3 sentence summary", "category": "education|entertainment|motivation|comedy|news|tutorial|interview|other", "keyTopics": ["topic1","topic2","topic3"], "sentiment": "positive|neutral|negative", "estimatedDuration": <integer seconds> }`
          }
        ],
        temperature: 0.3,
        max_tokens: 1024
      });
      const parsed = inworldParseJSON(response);
      return z2.object({
        summary: z2.string(),
        category: z2.string(),
        keyTopics: z2.array(z2.string()),
        sentiment: z2.string(),
        estimatedDuration: z2.number(),
        modelUsed: z2.string().optional()
      }).parse({ ...parsed, modelUsed });
    } catch (err) {
      if (err instanceof TRPCError3) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: `Transcript analysis failed: ${msg}` });
    }
  }),
  /**
   * POST /api/trpc/gemini.testConnection
   * Tests the Inworld API key and returns available model count.
   */
  testConnection: publicProcedure.input(z2.object({ apiKey: z2.string().min(1) })).mutation(async ({ input }) => {
    try {
      const models = await inworldListModels(input.apiKey);
      return { success: true, modelCount: models.length, message: `Connected! ${models.length} models available.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, modelCount: 0, message: msg };
    }
  })
});

// server/_core/systemRouter.ts
import { z as z3 } from "zod";

// server/_core/notification.ts
import { TRPCError as TRPCError4 } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError4({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError4({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError4({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError4({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError4({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError4({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z3.object({
      timestamp: z3.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z3.object({
      title: z3.string().min(1, "title is required"),
      content: z3.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers.ts
import { z as z4 } from "zod";
import bcrypt from "bcryptjs";
import { SignJWT as SignJWT2 } from "jose";
import { promises as fsp } from "fs";

// server/subtitles.ts
var CAPTION_CANVAS_W = 1080;
var CAPTION_CANVAS_H = 1920;
var DEFAULT_CAPTION_STYLE = {
  font: "Montserrat",
  fontSize: 72,
  color: "#FFFFFF",
  highlightColor: "#FFE600",
  position: "bottom",
  outline: true
};
var PRESET_Y = { top: 12, center: 50, bottom: 82 };
function resolveCaptionAnchor(style, word) {
  const xPct = word?.posX ?? style.posX;
  const yPct = word?.posY ?? style.posY;
  if (xPct == null && yPct == null) return null;
  const clamp = (v) => Math.min(100, Math.max(0, v));
  const x = clamp(xPct ?? 50);
  const y = clamp(yPct ?? PRESET_Y[style.position] ?? 82);
  return {
    x: Math.round(x / 100 * CAPTION_CANVAS_W),
    y: Math.round(y / 100 * CAPTION_CANVAS_H)
  };
}
function cleanWord(raw) {
  return raw.replace(/>>+/g, "").replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)/g, "").replace(/[\u266A\u266B\u266C\u2669\u25AA\u25CF]/g, "").replace(/\*{2,}/g, "").replace(/<[^>]+>/g, "").replace(/&nbsp;|&amp;|&lt;|&gt;|&#39;|&apos;|&quot;/gi, "").replace(/-{2,}/g, "").trim();
}
function toAssColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return "&H00FFFFFF";
  const rgb = m[1];
  const r = rgb.slice(0, 2), g = rgb.slice(2, 4), b = rgb.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}
function toAssTime(seconds) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  const carry = cs === 100 ? 1 : 0;
  const cs2 = cs === 100 ? 0 : cs;
  return `${h}:${String(m).padStart(2, "0")}:${String(s + carry).padStart(2, "0")}.${String(cs2).padStart(2, "0")}`;
}
function escapeAssText(text2) {
  return text2.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\r?\n/g, " ").trim();
}
function synthesiseWordTimings(text2, durationSeconds) {
  const words = text2.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationSeconds <= 0) return [];
  const weights = words.map((w) => Math.max(2, w.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let elapsed = 0;
  return words.map((word, i) => {
    const span = weights[i] / totalWeight * durationSeconds;
    const start = elapsed;
    elapsed += span;
    return { word, start, end: Math.min(durationSeconds, elapsed) };
  });
}
function buildAssFile(words, style, clipDuration, synced = true) {
  const s = { ...DEFAULT_CAPTION_STYLE, ...style };
  const alignment = s.position === "top" ? 8 : s.position === "center" ? 5 : 2;
  const marginV = s.position === "center" ? 0 : Math.round(CAPTION_CANVAS_H * 0.12);
  const fontSize = Math.max(16, Math.round(s.fontSize));
  const outlineWidth = s.outline ? Math.max(2, Math.round(fontSize * 0.09)) : 0;
  const primary = toAssColor(s.color);
  const highlight = toAssColor(s.highlightColor);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${CAPTION_CANVAS_W}`,
    `PlayResY: ${CAPTION_CANVAS_H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${s.font},${fontSize},${primary},${primary},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outlineWidth},0,${alignment},60,60,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const events = [];
  if (synced) {
    const MAX_WORD_SECONDS = 1.2;
    const MIN_WORD_SECONDS = 0.12;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const token = escapeAssText(w.word).toUpperCase();
      if (!token) continue;
      const anchor = resolveCaptionAnchor(s, w);
      const posTag = anchor ? `{\\an5\\pos(${anchor.x},${anchor.y})}` : "";
      const text2 = `${posTag}{\\c${highlight}}${token}{\\c${primary}}`;
      const start = Math.max(0, w.start);
      const nextStart = i + 1 < words.length ? words[i + 1].start : Infinity;
      let end = Math.min(
        w.end,
        nextStart,
        start + MAX_WORD_SECONDS,
        clipDuration
      );
      if (end < start + MIN_WORD_SECONDS) {
        end = Math.min(start + MIN_WORD_SECONDS, nextStart, clipDuration);
      }
      if (end <= start) continue;
      events.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text2}`);
    }
  } else {
    const GROUP_SIZE = 3;
    for (let g = 0; g < words.length; g += GROUP_SIZE) {
      const group = words.slice(g, g + GROUP_SIZE);
      if (group.length === 0) continue;
      const phrase = group.map((gw) => escapeAssText(gw.word).toUpperCase()).filter(Boolean).join(" ");
      if (!phrase) continue;
      const anchor = resolveCaptionAnchor(s, group[0]);
      const text2 = anchor ? `{\\an5\\pos(${anchor.x},${anchor.y})}${phrase}` : phrase;
      const start = Math.max(0, group[0].start);
      const nextStart = g + GROUP_SIZE < words.length ? words[g + GROUP_SIZE].start : clipDuration;
      const end = Math.min(clipDuration, Math.max(start + 0.2, nextStart));
      if (end <= start) continue;
      events.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text2}`);
    }
  }
  return `${header.join("\n")}
${events.join("\n")}
`;
}
function hasCaptions(words) {
  return Array.isArray(words) && words.length > 0;
}
function transcriptSliceFor(transcript, clipStart, clipEnd, videoDuration) {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (videoDuration && videoDuration > 0) {
    const from2 = Math.floor(clipStart / videoDuration * words.length);
    const to = Math.ceil(clipEnd / videoDuration * words.length);
    return words.slice(
      Math.max(0, Math.min(from2, words.length - 1)),
      Math.min(words.length, Math.max(from2 + 1, to))
    );
  }
  const WORDS_PER_SECOND = 2.5;
  const from = Math.max(0, Math.floor(clipStart * WORDS_PER_SECOND));
  const count = Math.max(1, Math.ceil((clipEnd - clipStart) * WORDS_PER_SECOND));
  return words.slice(from, from + count);
}
function buildClipCaptions(input) {
  const duration = input.clipEnd - input.clipStart;
  if (!(duration > 0)) return null;
  const style = { ...DEFAULT_CAPTION_STYLE, ...input.savedStyle ?? {} };
  const rebase = (words) => words.map((w) => ({ word: cleanWord(w.word), start: w.start - input.clipStart, end: w.end - input.clipStart })).filter((w) => w.end > 0 && w.start < duration && w.word).map((w) => ({
    word: w.word,
    start: Math.max(0, w.start),
    end: Math.min(duration, w.end)
  })).filter((w) => w.end > w.start);
  if (Array.isArray(input.savedWords) && input.savedWords.length > 0) {
    const relative = rebase(input.savedWords);
    if (relative.length > 0) return { words: relative, style, synced: true };
  }
  if (Array.isArray(input.transcriptWords) && input.transcriptWords.length > 0) {
    const relative = rebase(input.transcriptWords);
    if (relative.length > 0) return { words: relative, style, synced: true };
  }
  const transcript = input.transcript?.trim();
  if (!transcript) return null;
  const slice = transcriptSliceFor(transcript, input.clipStart, input.clipEnd, input.videoDuration);
  if (slice.length === 0) return null;
  return { words: synthesiseWordTimings(slice.join(" "), duration), style, synced: false };
}

// server/stt.ts
import { promises as fs5 } from "fs";
import path4 from "path";
var INWORLD_STT_URL = "https://api.inworld.ai/stt/v1/transcribe";
var SttError = class extends Error {
};
var MAX_AUDIO_MB = 15;
async function extractAudioRange(mediaPath, startSeconds, durationSeconds) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new SttError(FFMPEG_MISSING);
  await ensureDirs();
  const dir = await fs5.mkdtemp(path4.join(RENDER_TMP_DIR, "stt-"));
  const out = path4.join(dir, "audio.mp3");
  await execAsync(
    `${q(ffmpeg)} -ss ${Math.max(0, startSeconds)} -i ${q(mediaPath)} -t ${durationSeconds} -vn -ac 1 -ar 16000 -b:a 64k -y -loglevel error ${q(out)}`,
    { timeout: 3e5, maxBuffer: 16 * 1024 * 1024 }
  );
  const stat = await fs5.stat(out).catch(() => null);
  if (!stat || stat.size === 0) {
    await fs5.rm(dir, { recursive: true, force: true }).catch(() => {
    });
    throw new SttError("Could not extract audio for transcription.");
  }
  if (stat.size / (1024 * 1024) > MAX_AUDIO_MB) {
    await fs5.rm(dir, { recursive: true, force: true }).catch(() => {
    });
    throw new SttError("This clip's audio is too long to transcribe in one request.");
  }
  return out;
}
function toSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e4 ? value / 1e3 : value;
  }
  if (typeof value === "string") {
    const m = /^(-?\d+(?:\.\d+)?)s?$/.exec(value.trim());
    if (m) return Number(m[1]);
  }
  return null;
}
function extractWords(payload) {
  const out = [];
  const readWord = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const o = raw;
    const text2 = [o.word, o.text, o.value].find((v) => typeof v === "string" && v.trim());
    if (!text2) return null;
    const start = toSeconds(o.start ?? o.startTime ?? o.startOffset ?? o.startSeconds ?? o.from);
    const end = toSeconds(o.end ?? o.endTime ?? o.endOffset ?? o.endSeconds ?? o.to);
    if (start == null || end == null) return null;
    return { word: text2.trim(), start, end: Math.max(start, end) };
  };
  const visit = (node, depth) => {
    if (depth > 6 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) {
        const w = readWord(item);
        if (w) out.push(w);
        else visit(item, depth + 1);
      }
      return;
    }
    for (const value of Object.values(node)) {
      visit(value, depth + 1);
    }
  };
  visit(payload, 0);
  const seen = /* @__PURE__ */ new Set();
  return out.filter((w) => {
    const key = `${w.word}@${w.start.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.start - b.start);
}
function extractText(payload) {
  const o = payload;
  const candidates = [
    o?.transcription?.transcript,
    o?.transcription?.text,
    o?.transcript,
    o?.text,
    o?.results?.[0]?.transcript
  ];
  const hit = candidates.find((v) => typeof v === "string" && v.trim());
  return typeof hit === "string" ? hit.trim() : "";
}
async function transcribeAudio(opts) {
  const audio = await fs5.readFile(opts.audioPath);
  const res = await fetch(INWORLD_STT_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${opts.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      transcribeConfig: {
        modelId: "groq/whisper-large-v3",
        language: opts.language ?? "en",
        audioEncoding: "MP3",
        // Ask for word timings. Harmless if the provider ignores it.
        enableWordTimeOffsets: true,
        enableWordTimestamps: true,
        timestampGranularities: ["word", "segment"]
      },
      audioData: { content: audio.toString("base64") }
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new SttError(`Inworld STT error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const payload = await res.json();
  const text2 = extractText(payload);
  const rawWords = extractWords(payload);
  if (opts.debugShape) {
    const top = payload && typeof payload === "object" ? Object.keys(payload) : [];
    const inner = payload?.transcription;
    console.log(
      `[STT] response keys=[${top.join(",")}] transcription keys=[${inner && typeof inner === "object" ? Object.keys(inner).join(",") : "-"}] words found=${rawWords.length}`
    );
  }
  const offset = opts.offsetSeconds ?? 0;
  const words = rawWords.map((w) => ({
    word: w.word,
    start: w.start + offset,
    end: w.end + offset
  }));
  return { text: text2, words, timed: words.length > 0 };
}
async function cleanupAudio(audioPath) {
  await fs5.rm(path4.dirname(audioPath), { recursive: true, force: true }).catch(() => {
  });
}

// server/routers.ts
import { TRPCError as TRPCError5 } from "@trpc/server";
import { nanoid } from "nanoid";

// server/render.ts
import { promises as fs6 } from "fs";
import { spawn } from "child_process";
import path5 from "path";
import os3 from "os";
import crypto2 from "crypto";

// shared/framing.ts
var EASE_FN = {
  linear: (p) => p,
  in: (p) => p * p,
  out: (p) => 1 - (1 - p) * (1 - p),
  // Smoothstep: starts and ends at zero velocity with no branching.
  inOut: (p) => p * p * (3 - 2 * p)
};
function easeExpr(ease, p) {
  switch (ease) {
    case "linear":
      return `(${p})`;
    case "in":
      return `((${p})*(${p}))`;
    case "out":
      return `(1-(1-(${p}))*(1-(${p})))`;
    case "inOut":
      return `((${p})*(${p})*(3-2*(${p})))`;
  }
}
var clamp01 = (v) => Math.min(1, Math.max(0, v));
function interpolateCrop(from, to, ease, progress) {
  const e = EASE_FN[ease](clamp01(progress));
  const z0 = Math.max(0.01, from.zoom), z1 = Math.max(0.01, to.zoom);
  return {
    zoom: z0 * Math.pow(z1 / z0, e),
    offsetX: from.offsetX + (to.offsetX - from.offsetX) * e,
    offsetY: from.offsetY + (to.offsetY - from.offsetY) * e
  };
}
function segmentTarget(seg) {
  return seg.to ?? { zoom: seg.zoom, offsetX: seg.offsetX, offsetY: seg.offsetY };
}
function isAnimated(seg) {
  if (!seg.to) return false;
  const t2 = seg.to;
  return Math.abs(t2.zoom - seg.zoom) > 1e-3 || Math.abs(t2.offsetX - seg.offsetX) > 1e-3 || Math.abs(t2.offsetY - seg.offsetY) > 1e-3;
}
function easeWindow(seg) {
  return [clamp01(seg.easeFrom ?? 0), clamp01(seg.easeTo ?? 1)];
}
function curveProgress(seg, localProgress) {
  const [p0, p1] = easeWindow(seg);
  return p0 + (p1 - p0) * clamp01(localProgress);
}
function framingAt(seg, timeInClip) {
  const span = seg.end - seg.start;
  if (!isAnimated(seg) || span <= 0) {
    return { zoom: seg.zoom, offsetX: seg.offsetX, offsetY: seg.offsetY };
  }
  const local = (timeInClip - seg.start) / span;
  return interpolateCrop(
    seg,
    segmentTarget(seg),
    seg.ease ?? "inOut",
    curveProgress(seg, local)
  );
}
function sliceSegment(seg, start, end) {
  const span = seg.end - seg.start;
  if (!isAnimated(seg) || span <= 0) return { ...seg, start, end };
  return {
    ...seg,
    start,
    end,
    easeFrom: curveProgress(seg, (start - seg.start) / span),
    easeTo: curveProgress(seg, (end - seg.start) / span)
  };
}

// server/render.ts
var MediaError = class extends Error {
};
var TARGET_W = 1080;
var TARGET_H = 1920;
/**
 * Dynamic output profile based on source resolution.
 * Avoids blurry upscaling: if source is too low, output at 720x1280 instead.
 */
function getOutputProfile(srcW, srcH) {
  const outputIsSharpEnough = srcW >= 1280 && srcH >= 720;
  return {
    targetW: outputIsSharpEnough ? 1080 : 720,
    targetH: outputIsSharpEnough ? 1920 : 1280,
    crf: outputIsSharpEnough ? "17" : "18",
    isLowRes: !outputIsSharpEnough
  };
}
var DEFAULT_CROP = { zoom: 1, offsetX: 0, offsetY: 0 };
async function run(cmd, timeout) {
  try {
    const { stderr } = await execAsync(cmd, { timeout, maxBuffer: 64 * 1024 * 1024 });
    return stderr ?? "";
  } catch (err) {
    const e = err;
    const lines = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n").split("\n").map((l) => l.trim()).filter((l) => l && !/^\[download\]|^\[info\]|^Command failed:/.test(l));
    const errorLines = lines.filter((l) => /^ERROR:|^\s*error/i.test(l));
    const chosen = (errorLines.length ? errorLines : lines).slice(-3);
    const unique = chosen.filter((l, i) => chosen.indexOf(l) === i).join(" | ");
    throw new Error(unique || "the command failed");
  }
}
function classifyFailure(msg) {
  if (/sign in to confirm|not a bot|confirm your age/i.test(msg)) {
    return "YouTube asked this server to verify it is not a bot, so the video could not be downloaded. This usually affects datacenter or VPN IPs.";
  }
  if (/private video|age.?restrict|members.only/i.test(msg)) {
    return "This video is private, age-restricted, or members-only, so it cannot be hosted.";
  }
  if (/video unavailable|unavailable|removed|does not exist|blocked in your country/i.test(msg)) {
    return "This video is unavailable or blocked at its source.";
  }
  if (/is live|live event will begin|premiere/i.test(msg)) {
    return "This is a live or upcoming stream. Wait until the recording is published.";
  }
  if (/requested format|no video formats|format is not available/i.test(msg)) {
    return "No downloadable video format was available for this source.";
  }
  if (/HTTP Error 403|403:\s*Forbidden|unable to download video data/i.test(msg)) {
    return "The source website rejected this server's download request (HTTP 403). Try a different public source link for this rank; this specific video may require browser access that a cloud server cannot use.";
  }
  if (/timed out|ETIMEDOUT/i.test(msg)) {
    return "The operation timed out. Try a shorter video.";
  }
  if (/unsupported url/i.test(msg)) {
    return "This URL is not supported.";
  }
  if (/no space left|ENOSPC/i.test(msg)) {
    return "The server ran out of disk space.";
  }
  return null;
}
function assertSafeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new MediaError("The video source is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MediaError("Only http(s) video sources are supported.");
  }
  return parsed.toString();
}
function runStreaming(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd: opts.cwd });
    const tail = [];
    const captured = [];
    let buffer = "";
    const consume = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        opts.onLine?.(trimmed);
        if (opts.captureAll) captured.push(trimmed);
        if (!/^\[download\]/.test(trimmed)) {
          tail.push(trimmed);
          if (tail.length > 12) tail.shift();
        }
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the operation timed out"));
    }, opts.timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(captured.join("\n"));
      const errorLines = tail.filter((l) => /^ERROR:|^\s*error/i.test(l));
      const chosen = (errorLines.length ? errorLines : tail).slice(-3);
      const unique = chosen.filter((l, i) => chosen.indexOf(l) === i).join(" | ");
      reject(new Error(unique || `exited with code ${code}`));
    });
  });
}
async function findWritten(dir, stem) {
  const files = await fs6.readdir(dir).catch(() => []);
  const match = files.filter((f) => f.startsWith(stem) && !f.endsWith(".part") && !f.endsWith(".ytdl")).sort((a, b) => b.length - a.length)[0];
  return match ? path5.join(dir, match) : null;
}
async function probeMedia(filePath) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new MediaError(FFMPEG_MISSING);
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe"));
  try {
  const { stdout } = await execAsync(
    `${q(ffprobe)} -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,avg_frame_rate -show_entries format=duration -of json ${q(filePath)}`,
    { timeout: 6e4, maxBuffer: 8 * 1024 * 1024 }
  );
  const meta = JSON.parse(stdout);
  const stream = meta.streams?.[0];
  const parseRate = (value) => {
    if (!value) return 0;
    const [num, den] = value.split("/");
    const n = Number(num), d = den === void 0 ? 1 : Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
    const fps = n / d;
    return Number.isFinite(fps) && fps > 0 && fps < 1e3 ? fps : 0;
  };
  return {
    duration: Number(meta.format?.duration ?? 0),
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
    fps: parseRate(stream?.avg_frame_rate) || parseRate(stream?.r_frame_rate) || 0
  };
  } catch (probeErr) {
    // ffprobe not available or failed — get duration from ffmpeg -i header
    try {
      const result = await execAsync(
        `${q(ffmpeg)} -i ${q(filePath)} 2>&1 || true`,
        { timeout: 3e4, maxBuffer: 8 * 1024 * 1024 }
      ).catch((e) => ({ stdout: e?.stdout ?? "", stderr: e?.stderr ?? "" }));
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output);
      const dur = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : 0;
      const resMatch = /(\d{2,5})x(\d{2,5})/.exec(output);
      const w = resMatch ? Number(resMatch[1]) : 1920;
      const h = resMatch ? Number(resMatch[2]) : 1080;
      const fpsMatch = /(\d+(?:\.\d+)?)\s*fps/.exec(output);
      const fps = fpsMatch ? Number(fpsMatch[1]) : 30;
      if (dur > 0) return { duration: dur, width: w, height: h, fps };
      // File might exist but be unreadable
      const stat = await fs6.stat(filePath).catch(() => null);
      if (stat && stat.size > 1000) {
        return { duration: 600, width: w, height: h, fps };
      }
      throw probeErr;
    } catch {
      const stat = await fs6.stat(filePath).catch(() => null);
      if (stat && stat.size > 1000) {
        return { duration: 600, width: 1920, height: 1080, fps: 30 };
      }
      throw probeErr;
    }
  }
}
async function hostVideo(opts) {
  const sourceUrl = assertSafeUrl(opts.sourceUrl);
  const maxMinutes = opts.maxMinutes ?? 180;
  const maxHeight = opts.maxHeight ?? 2160;
  const range = opts.range ?? null;
  const ytDlp = await findYtDlp();
  if (!ytDlp) throw new MediaError(YT_DLP_MISSING);
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new MediaError(FFMPEG_MISSING);
  await ensureDirs();
  const SECTION_BUFFER = 5;
  const offset = range ? Math.max(0, range.start - SECTION_BUFFER) : 0;
  const fullFileName = videoFileName(opts.videoId, `${sourceUrl}:full:h${maxHeight}`);
  const sectionFileName = range ? videoFileName(opts.videoId, `${sourceUrl}:${range.start}-${range.end}:h${maxHeight}`) : fullFileName;
  const describe = async (name, hostedOffset) => {
    const p = path5.join(VIDEOS_DIR, name);
    const stat = await fs6.stat(p).catch(() => null);
    if (!stat || stat.size === 0) return null;
    const meta = await probeMedia(p).catch(() => ({ duration: 0, width: 0, height: 0 }));
    return { fileName: name, url: urlFor("video", name), bytes: stat.size, offset: hostedOffset, ...meta };
  };
  const cachedFull = await describe(fullFileName, 0);
  if (cachedFull) return cachedFull;
  const cachedSection = range ? await describe(sectionFileName, offset) : null;
  if (cachedSection) return cachedSection;
  let fileName = sectionFileName;
  let outPath = path5.join(VIDEOS_DIR, fileName);
  const tmpDir = await fs6.mkdtemp(path5.join(os3.tmpdir(), `shortspro-host-${opts.videoId}-`));
  const stem = path5.join(tmpDir, "source");
  const ffmpegDir = path5.dirname(ffmpeg);
  let effectiveOffset = offset;
  /* Set when a selected clip falls back to one complete muxed source file.
   * That file is trimmed locally into the same padded interval as a section. */
  let compatibleFullSource = false;
  /* A predictable quality ladder keeps Top 5 responsive. We never wait for
   * unavailable 1440p/4K streams: the first available level is 1080p, then
   * 720p, 480p, and finally 360p. The last selector remains only as a
   * last-resort "do not get stuck" option for unusual source platforms. */
  const qualityLadder = [1080, 720, 480, 360].filter((height) => height <= maxHeight);
  const adaptiveFormatSelector = [
    ...qualityLadder.flatMap((height) => [
      `bv*[height=${height}][vcodec^=avc1]+ba[acodec^=mp4a]`,
      `bv*[height=${height}]+ba`,
      `b[height=${height}]`
    ]),
    "b[height<=360]",
    "b"
  ].join("/");
  const compatibleFormatSelector = [
    ...qualityLadder.flatMap((height) => [
      `b[ext=mp4][height=${height}]`,
      `b[height=${height}]`
    ]),
    "b[ext=mp4][height<=360]",
    "b[height<=360]",
    "b"
  ].join("/");
  try {
    const commonArgs = [
      "--no-playlist", ...YTDLP_COOKIE_ARGS,
      ...YT_CLIENT_ARGS,
      "--no-warnings",
      // Fail quickly when a provider leaves a media connection hanging.
      "--socket-timeout", "20",
      "--retries", "2",
      "--fragment-retries", "2",
      "--abort-on-unavailable-fragment",
      // Parallel fragments are the single biggest speed win on YouTube DASH.
      "--concurrent-fragments",
      process.env.YTDLP_CONCURRENT_FRAGMENTS ?? "2",
      /*
       * Adaptive-first format selection.
       *
       * Prefer separate high-quality video+audio streams (DASH/adaptive) since
       * they offer resolutions up to 4K. Fall back to progressive (muxed) only
       * when adaptive fails — progressive caps at 360p on YouTube currently.
       *
       * If a provider rejects an adaptive level, hostVideo immediately moves
       * to the same deterministic muxed quality ladder rather than waiting for
       * an unavailable higher-resolution stream.
       */
      "-f",
      adaptiveFormatSelector,
      /* Each fallback has an exact height, so only sort within that level. */
      "-S",
      ["fps", "codec:avc:m4a", "vbr", "abr"].join(","),
      "--merge-output-format",
      "mp4",
      "--ffmpeg-location",
      ffmpegDir,
      // Never write captions: subtitles come from our own pipeline.
      "--no-write-sub",
      "--no-write-auto-sub",
      "--no-embed-subs",
      // Emit progress on its own lines so it can be parsed reliably.
      "--newline",
      "--progress",
      "-o",
      `${stem}.%(ext)s`
    ];
    const makeProgressHandler = () => {
      let seenStreams = 0;
      let lastPercent = 0;
      return (line) => {
        const m = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(line);
        if (!m) return;
        const raw = Number(m[1]);
        if (raw < lastPercent - 20) seenStreams = Math.min(seenStreams + 1, 1);
        lastPercent = raw;
        const scaled = seenStreams === 0 ? raw * 0.85 : 85 + raw * 0.1;
        opts.onProgress?.(Math.max(0, Math.min(95, Math.round(scaled))));
      };
    };
    /*
     * For a clip render, download only a small padded interval around its chosen
     * highlight. The previous implementation fetched the complete source at
     * 2160p, which can run for many minutes and stall a 1 GB Fly machine.
     */
    const sectionArgs = range ? [
      "--download-sections",
      `*${offset.toFixed(3)}-${(range.end + SECTION_BUFFER).toFixed(3)}`,
      /* Let yt-dlp manage the selected range and merge its streams. An external
       * ffmpeg downloader can emit an incomplete merged file for adaptive audio
       * and video streams, which then fails during the preview normalization. */
    ] : [];
    const downloadFull = () => runStreaming(
      ytDlp,
      [...commonArgs, ...sectionArgs, "--match-filter", `duration < ${maxMinutes * 60}`, sourceUrl],
      { timeout: range ? 18e4 : 18e5, onLine: makeProgressHandler() }
    );
    /*
     * Generic fallback for TikTok, X and providers where the specialised
     * adaptive selector returns no format. It deliberately uses no YouTube
     * client override and accepts the best public stream the provider exposes.
     */
    /* Direct compatible short-range path. This is the normal fallback for a
     * selected highlight: it works for a 15-second clip even if the complete
     * original is much longer than the bounded full-source rescue path. */
    const downloadShortCompatible = (clientArgs = []) => runStreaming(
      ytDlp,
      [
        "--no-playlist", ...YTDLP_COOKIE_ARGS, ...clientArgs,
        "--no-warnings",
        "--socket-timeout", "20",
        "--retries", "2",
        "--fragment-retries", "2",
        "--abort-on-unavailable-fragment",
        "-f", compatibleFormatSelector,
        "--merge-output-format", "mp4",
        "--ffmpeg-location", ffmpegDir,
        "--no-write-sub", "--no-write-auto-sub", "--no-embed-subs",
        "--newline", "--progress",
        "-o", `${stem}.%(ext)s`,
        ...sectionArgs,
        "--match-filter", `duration < ${maxMinutes * 60}`,
        sourceUrl
      ],
      { timeout: 18e4, onLine: makeProgressHandler() }
    );
    const downloadCompatible = (clientArgs = []) => runStreaming(
      ytDlp,
      [
        "--no-playlist", ...YTDLP_COOKIE_ARGS, ...clientArgs,
        "--no-warnings",
        "--socket-timeout", "20",
        "--retries", "2",
        "--fragment-retries", "2",
        "--abort-on-unavailable-fragment",
        /* Stable fallback: prefer one public muxed MP4 stream so yt-dlp does
         * not need to assemble brittle adaptive audio/video segments on Fly.
         * It may be lower resolution than the primary path, but produces a
         * compatible, renderable source instead of leaving the rank stuck. */
        "-f", compatibleFormatSelector,
        /* Do not pass --download-sections, --merge-output-format, or an
         * ffmpeg location here. Even a progressive stream causes yt-dlp to
         * invoke FFmpeg for an in-place section cut on some YouTube responses,
         * which is exactly the failing path in the production logs. Download a
         * single already-muxed file first; this function normalizes it below. */
        "--no-write-sub", "--no-write-auto-sub", "--no-embed-subs",
        "--newline", "--progress",
        "-o", `${stem}.%(ext)s`,
        /* Full-source fallback is deliberately bounded so a multi-hour video
         * cannot fill the 1 GB service volume. Typical ranked sources are well
         * below this twenty-minute / 350 MB limit. */
        "--match-filter", `duration < ${Math.min(maxMinutes, 20) * 60}`,
        "--max-filesize", "350M",
        sourceUrl
      ],
      { timeout: range ? 9e5 : 18e5, onLine: makeProgressHandler() }
    );
    const downloadWithFallback = async () => {
      try {
        await downloadFull();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/403|Forbidden|requested format|no video formats|format is not available|no downloadable|SABR/i.test(msg)) {
          console.warn(`[Host] Preferred adaptive format was unavailable. Downloading one stable public muxed MP4 source before local normalization to avoid the FFmpeg section-cut failure...`);
          /* Clear partial fragments before retrying with the provider-compatible selector. */
          for (const f of await fs6.readdir(tmpDir).catch(() => [])) {
            await fs6.rm(path5.join(tmpDir, f), { force: true }).catch(() => {});
          }
          compatibleFullSource = false;
          try {
            /* Keep normal long videos on a selected short range. */
            await downloadShortCompatible();
          } catch (shortErr) {
            const shortMessage = shortErr instanceof Error ? shortErr.message : String(shortErr);
            if (/HTTP Error 403|403:\s*Forbidden|unable to download video data/i.test(shortMessage)) {
              console.warn(`[Host] Default public short stream was rejected with 403. Retrying once with alternate public YouTube clients...`);
              for (const f of await fs6.readdir(tmpDir).catch(() => [])) {
                await fs6.rm(path5.join(tmpDir, f), { force: true }).catch(() => {});
              }
              await downloadShortCompatible(YT_PUBLIC_FALLBACK_CLIENT_ARGS);
            } else if (range && /ffmpeg|exited with code|merge/i.test(shortMessage)) {
              /* Only a section-cut compatibility failure uses the complete,
               * size-bounded source rescue. It is never the normal path. */
              console.warn(`[Host] Compatible short-range cut failed; using the bounded full-source rescue for this source...`);
              for (const f of await fs6.readdir(tmpDir).catch(() => [])) {
                await fs6.rm(path5.join(tmpDir, f), { force: true }).catch(() => {});
              }
              compatibleFullSource = true;
              await downloadCompatible();
            } else {
              throw shortErr;
            }
          }
        } else {
          throw err;
        }
      }
    };
    if (range) {
      console.log(`[Host] Downloading selected ${(range.end - range.start).toFixed(1)}s range for clip ${range.start}-${range.end}s at best available quality...`);
      await downloadWithFallback();
      /* Both paths now write the same padded local interval. The compatibility
       * path downloads one safe muxed file, then trims it locally below. */
      effectiveOffset = offset;
    } else {
      await downloadWithFallback();
    }
    opts.onProgress?.(96);
    const downloaded = await findWritten(tmpDir, "source");
    if (!downloaded) {
      if (range) {
        throw new MediaError(
          "The selected short clip could not be downloaded from this source. Try another public video or choose a different 15-second moment."
        );
      }
      throw new MediaError(
        `The complete video could not be downloaded. It may be longer than the ${maxMinutes}-minute limit.`
      );
    }
    /* The stable compatible fallback deliberately downloaded the whole muxed
     * file without ffmpeg. Make a short, accurately trimmed local working copy
     * here instead of asking yt-dlp to section-cut it during download. */
    const localTrimArgs = compatibleFullSource && range ? [
      `-ss ${offset.toFixed(3)}`,
      `-t ${(range.end + SECTION_BUFFER - offset).toFixed(3)}`
    ] : [];
    const normaliseCmd = [
      q(ffmpeg),
      `-i ${q(downloaded)}`,
      ...localTrimArgs,
      // A local trim is encoded for frame-accurate timestamp handling. Other
      // already-sectioned media stays stream-copied for maximum quality/speed.
      compatibleFullSource && range ? "-c:v libx264 -preset veryfast -crf 16 -c:a aac -b:a 192k" : "-c copy",
      // Drop any subtitle/data streams the source carried.
      "-map 0:v:0 -map 0:a:0?",
      compatibleFullSource && range ? "-movflags +faststart -avoid_negative_ts make_zero -pix_fmt yuv420p" : "-movflags +faststart",
      "-y -loglevel error",
      q(outPath)
    ].join(" ");
    try {
      await run(normaliseCmd, 9e5);
    } catch (copyErr) {
      const copyMessage = copyErr instanceof Error ? copyErr.message : String(copyErr);
      console.warn(`[Host] Source normalization failed; rebuilding the local range for compatibility: ${copyMessage.slice(0, 240)}`);
      const reencodeCmd = [
        q(ffmpeg),
        "-fflags +genpts",
        `-i ${q(downloaded)}`,
        ...localTrimArgs,
        "-map 0:v:0 -map 0:a:0?",
        // A working copy that clips are cut from, so keep it near-transparent;
        // every loss here is inherited by every export made from it.
        "-c:v libx264 -preset veryfast -crf 16",
        "-c:a aac -b:a 192k",
        "-movflags +faststart -avoid_negative_ts make_zero -pix_fmt yuv420p",
        "-y -loglevel error",
        q(outPath)
      ].join(" ");
      try {
        await run(reencodeCmd, 18e5);
      } catch (reencodeErr) {
        const reencodeMessage = reencodeErr instanceof Error ? reencodeErr.message : String(reencodeErr);
        throw new MediaError(`Selected source range could not be normalized: ${reencodeMessage.slice(0, 420)}`);
      }
    }
    const stat = await fs6.stat(outPath).catch(() => null);
    if (!stat || stat.size === 0) throw new MediaError("Hosting produced an empty file.");
    const check = await probeMedia(outPath).catch(() => null);
    if (!check || check.duration < 0.5) {
      throw new MediaError(
        "The import produced no usable video. The source may be unavailable or the requested range invalid."
      );
    }
    opts.onProgress?.(100);
    const meta = await probeMedia(outPath).catch(() => ({ duration: 0, width: 0, height: 0 }));
    /* Source quality logging and warning */
    const isLowRes = meta.width > 0 && meta.height > 0 && (meta.width < 1280 || meta.height < 720);
    if (isLowRes) {
      console.warn(
        `[Host] ⚠️ Low-quality source: ${meta.width}x${meta.height} for video ${opts.videoId}. ` +
        `Vertical exports will be upscaled and may appear soft. For sharp results, upload a 1080p+ source directly.`
      );
    } else {
      const selectedTier = [1080, 720, 480, 360].find((height) => meta.height >= height) ?? meta.height;
      console.log(`[Host] Video ${opts.videoId}: using ${selectedTier}p source (${meta.width}x${meta.height} ${meta.fps?.toFixed(0) ?? "?"}fps) — sufficient for sharp 1080x1920 export`);
    }
    return { fileName, url: urlFor("video", fileName), bytes: stat.size, offset: effectiveOffset, ...meta, isLowRes };
  } catch (err) {
    await fs6.rm(outPath, { force: true }).catch(() => {
    });
    if (err instanceof MediaError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new MediaError(classifyFailure(msg) ?? `Hosting failed: ${msg.slice(0, 250)}`);
  } finally {
    await fs6.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
function normaliseSegments(segments, duration, base) {
  const full = { ...base, start: 0, end: duration };
  if (!segments || segments.length === 0) return [full];
  const clean = segments.map((s) => {
    const from = {
      zoom: Number.isFinite(s.zoom) ? s.zoom : base.zoom,
      offsetX: Number.isFinite(s.offsetX) ? s.offsetX : base.offsetX,
      offsetY: Number.isFinite(s.offsetY) ? s.offsetY : base.offsetY
    };
    const target = s.to ? {
      zoom: Number.isFinite(s.to.zoom) ? s.to.zoom : from.zoom,
      offsetX: Number.isFinite(s.to.offsetX) ? s.to.offsetX : from.offsetX,
      offsetY: Number.isFinite(s.to.offsetY) ? s.to.offsetY : from.offsetY
    } : null;
    return {
      ...from,
      to: target,
      ease: s.ease ?? "inOut",
      easeFrom: s.easeFrom,
      easeTo: s.easeTo,
      start: Math.max(0, Math.min(duration, s.start)),
      end: Math.max(0, Math.min(duration, s.end)),
      // Kept so a clamped segment can be re-parameterised onto its own curve.
      rawStart: s.start,
      rawEnd: s.end
    };
  }).filter((s) => s.end - s.start > 0.05).sort((a, b) => a.start - b.start);
  if (clean.length === 0) return [full];
  const out = [];
  let cursor = 0;
  for (const seg of clean) {
    const start = Math.max(seg.start, cursor);
    if (seg.end - start <= 0.05) continue;
    if (start - cursor > 0.05) {
      out.push({ ...base, start: cursor, end: start });
    }
    const span = seg.rawEnd - seg.rawStart;
    const full2 = {
      zoom: seg.zoom,
      offsetX: seg.offsetX,
      offsetY: seg.offsetY,
      to: seg.to,
      ease: seg.ease,
      easeFrom: seg.easeFrom,
      easeTo: seg.easeTo,
      start: seg.rawStart,
      end: seg.rawEnd
    };
    if (seg.to && span > 0.01 && (start > seg.rawStart + 1e-3 || seg.end < seg.rawEnd - 1e-3)) {
      out.push(sliceSegment(full2, start, seg.end));
    } else {
      out.push({ ...full2, start, end: seg.end });
    }
    cursor = seg.end;
  }
  if (duration - cursor > 0.05) out.push({ ...base, start: cursor, end: duration });
  return out.length > 0 ? out : [full];
}
function buildCropFilter(crop, srcW = 0, srcH = 0) {
  /*
   * Zoom for a 9:16 export.
   *
   * 1.0 is "cover": the source is scaled just enough to fill the frame, which
   * on a 16:9 source means the left and right sides are cropped away.
   * Above 1.0 crops in tighter. Below 1.0 pulls back to reveal more of the
   * frame, which cannot fill 9:16 any more, so the leftover is padded.
   *
   * When the source size is known the geometry is worked out in pixels. That
   * keeps `crop` from ever being asked for a region larger than the scaled
   * frame, which is what made zoom-out fail with "Error reinitializing filters".
   */
  const zoom = Math.max(0.1, Math.min(10, Number.isFinite(crop.zoom) ? crop.zoom : 1));
  const ox = Math.min(1, Math.max(-1, Number.isFinite(crop.offsetX) ? crop.offsetX : 0));
  const oy = Math.min(1, Math.max(-1, Number.isFinite(crop.offsetY) ? crop.offsetY : 0));
  const barColor = typeof crop.barColor === "string" && /^#[0-9a-f]{6}$/i.test(crop.barColor) ? `0x${crop.barColor.slice(1)}` : "black";
  if (srcW > 0 && srcH > 0) {
    /* h264 with yuv420p needs even dimensions. */
    const even = (n) => Math.max(2, 2 * Math.round(n / 2));
    /* 0.50× is the full-frame letterbox choice: preserve the complete 16:9
     * source at output width and pad only above and below. Between 0.51× and
     * 0.99× the normal geometry produces a gradual crop reduction, rather
     * than jumping straight to the complete 16:9 frame. */
    if (zoom <= 0.5 && srcW > srcH) {
      const fullW = TARGET_W;
      const fullH = even(TARGET_W * srcH / srcW);
      const barY = Math.round((TARGET_H - fullH) / 2);
      return `scale=${fullW}:${fullH}:flags=lanczos,pad=${TARGET_W}:${TARGET_H}:0:${barY}:${barColor},setsar=1`;
    }
    const cover = Math.max(TARGET_W / srcW, TARGET_H / srcH);
    const scaledW = even(srcW * cover * zoom);
    const scaledH = even(srcH * cover * zoom);
    const cropW = Math.min(TARGET_W, scaledW);
    const cropH = Math.min(TARGET_H, scaledH);
    const slackX = Math.max(0, scaledW - cropW);
    const slackY = Math.max(0, scaledH - cropH);
    const x = Math.round(slackX / 2 + ox * (slackX / 2));
    const y = Math.round(slackY / 2 + oy * (slackY / 2));
    const parts = [`scale=${scaledW}:${scaledH}:flags=lanczos`, `crop=${cropW}:${cropH}:${x}:${y}`];
    /*
     * A 9:16 crop out of a 16:9 source only keeps about a third of its width,
     * so the kept region is enlarged by `cover * zoom`. On a low-resolution
     * source that is a large enlargement and the result looks soft. A light
     * unsharp pass restores some of the apparent detail; the amount is kept
     * modest so it does not ring around edges.
     */
    const upscale = cover * zoom;
    if (upscale >= 2) {
      const amount = Math.min(0.8, 0.25 * (upscale - 1)).toFixed(2);
      parts.push(`unsharp=5:5:${amount}:5:5:0.0`);
    }
    /* Only needed when pulled back far enough that the frame is not covered. */
    if (cropW !== TARGET_W || cropH !== TARGET_H) {
      parts.push(
        `pad=${TARGET_W}:${TARGET_H}:${Math.round((TARGET_W - cropW) / 2)}:${Math.round((TARGET_H - cropH) / 2)}:${barColor}`
      );
    }
    parts.push("setsar=1");
    return parts.join(",");
  }
  /* Source size unknown: stay at or above cover so the crop is always valid. */
  const safeZoom = Math.max(1, zoom);
  const scale = `scale=iw*${safeZoom}*max(${TARGET_W}/iw\\,${TARGET_H}/ih):ih*${safeZoom}*max(${TARGET_W}/iw\\,${TARGET_H}/ih):flags=lanczos`;
  const ex = `(iw-${TARGET_W})/2+${ox}*max(0\\,(iw-${TARGET_W})/2)`;
  const ey = `(ih-${TARGET_H})/2+${oy}*max(0\\,(ih-${TARGET_H})/2)`;
  return `${scale},crop=${TARGET_W}:${TARGET_H}:${ex}:${ey},setsar=1`;
}
var ZOOMPAN_MAX = 10;
function bandFor(srcW, srcH) {
  const cover = Math.max(TARGET_W / srcW, TARGET_H / srcH);
  const bandW = 2 * Math.round(srcW * cover / 2);
  const bandH = 2 * Math.round(srcH * cover / 2);
  return { bandW, bandH };
}
function windowFor(bandW, bandH, crop) {
  /* zoompan works inside a fixed band, so it cannot pull back past cover. */
  const zoom = Math.min(10, Math.max(1, crop.zoom));
  const w = TARGET_W / zoom, h = TARGET_H / zoom;
  const slackX = Math.max(0, bandW - w), slackY = Math.max(0, bandH - h);
  const ox = Math.min(1, Math.max(-1, crop.offsetX));
  const oy = Math.min(1, Math.max(-1, crop.offsetY));
  return { x: slackX / 2 * (1 + ox), y: slackY / 2 * (1 + oy), w, h };
}
function canvasForSegment(seg, bandW, bandH) {
  const to = segmentTarget(seg);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const STEPS = 32;
  for (let i = 0; i <= STEPS; i++) {
    const c = interpolateCrop(seg, to, seg.ease ?? "inOut", curveProgress(seg, i / STEPS));
    const w = windowFor(bandW, bandH, c);
    minX = Math.min(minX, w.x);
    minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x + w.w);
    maxY = Math.max(maxY, w.y + w.h);
  }
  const MARGIN = 8;
  minX -= MARGIN;
  minY -= MARGIN;
  maxX += MARGIN;
  maxY += MARGIN;
  const k = 2 * Math.ceil(
    Math.max((maxX - minX) / TARGET_W, (maxY - minY) / TARGET_H) * (TARGET_W / 9) / 2
  );
  const canvasW = 9 * k, canvasH = 16 * k;
  const originX = 2 * Math.floor(((minX + maxX) / 2 - canvasW / 2) / 2);
  const originY = 2 * Math.floor(((minY + maxY) / 2 - canvasH / 2) / 2);
  return { canvasW, canvasH, originX, originY };
}
function splitForZoomCap(seg, srcW, srcH, depth = 0) {
  const { bandW, bandH } = bandFor(srcW, srcH);
  const { canvasW } = canvasForSegment(seg, bandW, bandH);
  const maxZoom = Math.min(4, Math.max(
    framingAt(seg, seg.start).zoom,
    framingAt(seg, seg.end).zoom
  ));
  if (canvasW * maxZoom / TARGET_W <= ZOOMPAN_MAX * 0.95 || depth >= 5) return [seg];
  const mid = (seg.start + seg.end) / 2;
  const first = sliceSegment(seg, seg.start, mid);
  const second = sliceSegment(seg, mid, seg.end);
  return [
    ...splitForZoomCap(first, srcW, srcH, depth + 1),
    ...splitForZoomCap(second, srcW, srcH, depth + 1)
  ];
}
function buildAnimatedCropFilter(opts) {
  const { segment, srcW, srcH, fps } = opts;
  if (!(srcW > 0 && srcH > 0 && fps > 0)) return null;
  const duration = segment.end - segment.start;
  if (!(duration > 0.01)) return null;
  const { bandW, bandH } = bandFor(srcW, srcH);
  const { canvasW, canvasH, originX, originY } = canvasForSegment(segment, bandW, bandH);
  const interX = Math.max(0, originX);
  const interY = Math.max(0, originY);
  const interW = Math.min(bandW, originX + canvasW) - interX;
  const interH = Math.min(bandH, originY + canvasH) - interY;
  if (interW <= 0 || interH <= 0) return null;
  const evenDown = (v) => 2 * Math.floor(v / 2);
  const cropW = evenDown(interW), cropH = evenDown(interH);
  const padX = interX - originX, padY = interY - originY;
  if (cropW <= 0 || cropH <= 0) return null;
  if (padX + cropW > canvasW || padY + cropH > canvasH) return null;
  const to = segmentTarget(segment);
  const ease = segment.ease ?? "inOut";
  const [p0, p1] = easeWindow(segment);
  const local = `min(1\\,max(0\\,it/${duration.toFixed(6)}))`;
  const progress = p0 === 0 && p1 === 1 ? local : `(${p0.toFixed(6)}+${(p1 - p0).toFixed(6)}*${local})`;
  const e = easeExpr(ease, progress);
  const z0 = Math.min(4, Math.max(1, segment.zoom));
  const z1 = Math.min(4, Math.max(1, to.zoom));
  const zoomExpr = Math.abs(z1 - z0) < 1e-3 ? `${(canvasW * z0 / TARGET_W).toFixed(6)}` : `${(canvasW * z0 / TARGET_W).toFixed(6)}*pow(${(z1 / z0).toFixed(9)}\\,${e})`;
  const lerp = (a, b) => Math.abs(b - a) < 1e-4 ? `${a.toFixed(6)}` : `(${a.toFixed(6)}+${(b - a).toFixed(6)}*${e})`;
  const ox = lerp(
    Math.min(1, Math.max(-1, segment.offsetX)),
    Math.min(1, Math.max(-1, to.offsetX))
  );
  const oy = lerp(
    Math.min(1, Math.max(-1, segment.offsetY)),
    Math.min(1, Math.max(-1, to.offsetY))
  );
  const xExpr = `max(0\\,${bandW}-${canvasW}/zoom)/2*(1+${ox})-${originX}`;
  const yExpr = `max(0\\,${bandH}-${canvasH}/zoom)/2*(1+${oy})-${originY}`;
  return [
    `scale=${bandW}:${bandH}:flags=lanczos`,
    `crop=${cropW}:${cropH}:${interX}:${interY}`,
    `pad=${canvasW}:${canvasH}:${padX}:${padY}`,
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${TARGET_W}x${TARGET_H}:fps=${fps.toFixed(6)}`,
    `setsar=1`
  ].join(",");
}
async function renderClipFromHosted(opts) {
  const offset = opts.hostedOffset ?? 0;
  const start = Math.max(0, opts.startTime - offset);
  const end = opts.endTime - offset;
  const crop = opts.crop ?? DEFAULT_CROP;
  const captions = opts.captions && hasCaptions(opts.captions.words) ? opts.captions : null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new MediaError("Clip end time must be after the start time.");
  }
  if (end - start > 600) {
    throw new MediaError("Clips longer than 10 minutes are not supported.");
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new MediaError(FFMPEG_MISSING);
  try {
    await fs6.access(opts.hostedPath);
  } catch {
    throw new MediaError("The hosted video file is missing. Re-host the video and try again.");
  }
  const hostedMeta = await probeMedia(opts.hostedPath).catch(() => null);
  if (hostedMeta && hostedMeta.duration > 0 && start >= hostedMeta.duration - 0.1) {
    throw new MediaError(
      `CLIP_BEYOND_IMPORT:${start.toFixed(0)}:${hostedMeta.duration.toFixed(0)}`
    );
  }
  await ensureDirs();
  const duration = end - start;
  /* Top 5 clips already have no captions and receive their shared overlay in
   * the final composition. Encode them with a bounded fast profile so one
   * rank cannot spend fifteen minutes on an unnecessarily slow intermediate. */
  const rankedProfile = opts.renderProfile === "top5";
  /* The final Top 5 composition is 30 fps, so ranked intermediates must not
   * waste CPU encoding a 60 fps source that will be reduced immediately. */
  const outputFps = rankedProfile ? 30 : Math.round(hostedMeta?.fps || 30);
  const encoderPreset = rankedProfile ? "medium" : "slow";
  const outputCrf = rankedProfile ? "18" : (hostedMeta && hostedMeta.width >= 1280 ? "17" : "18");
  const renderTimeout = rankedProfile ? 3e5 : 9e5;
  const captionKey = captions ? crypto2.createHash("sha1").update(JSON.stringify({ w: captions.words, s: captions.style })).digest("hex").slice(0, 8) : "nocap";
  const normalised = normaliseSegments(opts.segments, duration, crop);
  const segments = hostedMeta && hostedMeta.width > 0 && hostedMeta.height > 0 ? normalised.flatMap(
    (s) => isAnimated(s) ? splitForZoomCap(s, hostedMeta.width, hostedMeta.height) : [s]
  ) : normalised;
  const moving = segments.some(isAnimated);
  const segmentKey = segments.length > 1 || moving ? crypto2.createHash("sha1").update(JSON.stringify(segments)).digest("hex").slice(0, 8) : "static";
  const fileName = clipFileName(
    opts.clipId,
    `${path5.basename(opts.hostedPath)}:${captionKey}:${segmentKey}`,
    start,
    end,
    crop.zoom,
    crop.offsetX,
    crop.offsetY,
    crop.barColor
  );
  const outPath = path5.join(CLIPS_DIR, fileName);
  try {
    const existing = await fs6.stat(outPath);
    if (existing.size > 0) {
      return { fileName, url: urlFor("clip", fileName), bytes: existing.size };
    }
  } catch {
  }
  const tmpDir = await fs6.mkdtemp(path5.join(RENDER_TMP_DIR, `clip-${opts.clipId}-`));
  try {
    const captionFilter = [];
    if (captions) {
      await fs6.writeFile(
        path5.join(tmpDir, CAPTION_FILE),
        buildAssFile(captions.words, captions.style, duration, captions.synced ?? true),
        "utf8"
      );
      const fontsRel = filterRelativePath(tmpDir, FONTS_DIR);
      captionFilter.push(`ass=${CAPTION_FILE}:fontsdir=${fontsRel}`);
    }
    const videoArgs = [];
    const framingFor = (seg) => {
      if (!isAnimated(seg)) return buildCropFilter(seg, hostedMeta?.width ?? 0, hostedMeta?.height ?? 0);
      const animated = buildAnimatedCropFilter({
        segment: seg,
        srcW: hostedMeta?.width ?? 0,
        srcH: hostedMeta?.height ?? 0,
        fps: hostedMeta?.fps ?? 0
      });
      if (animated) return animated;
      console.warn(
        `[Render] Clip ${opts.clipId}: cannot animate framing without source size/rate \u2014 holding the segment's starting framing instead.`
      );
      return buildCropFilter(framingAt(seg, seg.start), hostedMeta?.width ?? 0, hostedMeta?.height ?? 0);
    };
    if (segments.length <= 1 && !moving) {
      videoArgs.push(
        "-vf",
        [
          buildCropFilter(segments[0], hostedMeta?.width ?? 0, hostedMeta?.height ?? 0),
          ...captionFilter
        ].join(",")
      );
    } else {
      const parts = segments.map(
        (seg, i) => `[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS,${framingFor(seg)}[v${i}]`
      );
      const concatInputs = segments.map((_, i) => `[v${i}]`).join("");
      const graph = [
        ...parts,
        `${concatInputs}concat=n=${segments.length}:v=1:a=0[vcat]`,
        captionFilter.length > 0 ? `[vcat]${captionFilter.join(",")}[vout]` : `[vcat]null[vout]`
      ].join(";");
      videoArgs.push("-filter_complex", graph, "-map", "[vout]", "-map", "0:a?");
    }
    const args = [
      // -ss before -i seeks quickly; a local file keeps it accurate enough.
      "-ss",
      String(start),
      "-i",
      opts.hostedPath,
      "-t",
      String(duration),
      ...videoArgs,
      /*
       * This is the deliverable, so it is encoded for quality rather than speed.
       * CRF 17 with the slow preset is visually near-transparent and leaves
       * enough headroom that the re-encode every social platform applies does
       * not fall apart. High profile keeps 8x8 transforms, which matter for the
       * large flat areas typical of a zoomed crop.
       */
      "-c:v",
      "libx264",
      "-preset",
      encoderPreset,
      "-crf",
      outputCrf,
      "-profile:v",
      "high",
      "-level",
      "4.2",
      "-pix_fmt",
      "yuv420p",
      "-r", String(outputFps),
      "-fps_mode", "cfr",
      "-g", String(outputFps * 2),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      "-tag:v", "avc1",
      // Lanczos for any scaler ffmpeg inserts itself, not just our own filters.
      "-sws_flags",
      "lanczos+accurate_rnd+full_chroma_int",
      // Verbose only with captions: libass reports its font choice at this
      // level, which is how a silent substitution gets caught.
      "-y",
      "-loglevel",
      captions ? "verbose" : "error",
      outPath
    ];
    const ffmpegLog = await runStreaming(ffmpeg, args, {
      timeout: renderTimeout,
      cwd: tmpDir,
      captureAll: !!captions
    });
    let fontWarning;
    if (captions) {
      const substituted = detectFontSubstitution(ffmpegLog, captions.style.font);
      if (substituted) {
        fontWarning = `Captions were rendered in "${substituted}" because the font "${captions.style.font}" is not available to the renderer.`;
        console.warn(`[Render] Clip ${opts.clipId}: ${fontWarning}`);
      }
    }
    const stat = await fs6.stat(outPath).catch(() => null);
    if (!stat || stat.size === 0) throw new MediaError("Rendering produced an empty file.");
    const outMeta = await probeMedia(outPath).catch(() => null);
    if (!outMeta || outMeta.duration <= 0.05 || !outMeta.width || !outMeta.height) {
      throw new MediaError(
        "Rendering produced a file with no video frames. The clip range may fall outside the imported footage."
      );
    }
    return { fileName, url: urlFor("clip", fileName), bytes: stat.size, fontWarning };
  } catch (err) {
    await fs6.rm(outPath, { force: true }).catch(() => {
    });
    if (err instanceof MediaError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/fontconfig|cannot load font|ass/i.test(msg) && captions) {
      throw new MediaError(
        "Captions could not be rendered \u2014 the chosen font may be unavailable on the server. Try a different font."
      );
    }
    throw new MediaError(classifyFailure(msg) ?? `Rendering failed: ${msg.slice(0, 250)}`);
  } finally {
    await fs6.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
var CAPTION_FILE = "captions.ass";
function detectFontSubstitution(ffmpegLog, requestedFont) {
  const pattern = /fontselect:\s*\(([^,]+),[^)]*\)\s*->\s*([^,\n]+)/g;
  const matches = [];
  let m;
  while ((m = pattern.exec(ffmpegLog)) !== null) {
    matches.push({ requested: m[1].trim(), chosen: m[2].trim() });
  }
  if (matches.length === 0) return null;
  const normalise = (s) => s.toLowerCase().replace(/[-_\s]/g, "").replace(/(bold|regular|medium|black|semibold|light|italic|mt)+$/g, "");
  const wanted = normalise(requestedFont);
  for (const { requested, chosen } of matches) {
    if (normalise(requested) !== wanted) continue;
    if (!normalise(chosen).startsWith(wanted)) return chosen;
  }
  return null;
}

// server/routers.ts
async function captionsForClip(clip, video) {
  const saved = await getSubtitleByClip(clip.id);
  return buildClipCaptions({
    clipStart: clip.startTime ?? 0,
    clipEnd: clip.endTime ?? 0,
    savedWords: saved?.words,
    savedStyle: saved?.style,
    transcriptWords: video.transcriptWords,
    transcript: video.transcript,
    videoDuration: video.duration
  });
}
async function signJwt(payload, secret) {
  const key = new TextEncoder().encode(secret);
  return new SignJWT2(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30d").sign(key);
}

async function renderTop5Countdown(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new MediaError("Add at least one ranked clip before rendering.");
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new MediaError(FFMPEG_MISSING);
  await ensureDirs();
  const fingerprint = crypto2.createHash("sha1").update(JSON.stringify(entries)).digest("hex").slice(0, 10);
  const fileName = clipFileName(entries[0].clipId, `top5-overlay:${fingerprint}`, 0, entries.length, 1, 0, 0);
  const outPath = path5.join(CLIPS_DIR, fileName);
  const existing = await fs6.stat(outPath).catch(() => null);
  if (existing?.size > 0) return { url: urlFor("clip", fileName), bytes: existing.size };

  const tmpDir = await fs6.mkdtemp(path5.join(RENDER_TMP_DIR, "top5-overlay-"));
  try {
    const font = filterRelativePath(tmpDir, path5.join(FONTS_DIR, "Montserrat-Bold.ttf"));
    const timeline = [];
    let elapsed = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const sourcePath = localPathFromUrl(entry.downloadUrl);
      if (!sourcePath) throw new MediaError(`Rank ${entry.rank} has no rendered clip file. Render it first.`);
      await fs6.access(sourcePath);
      const meta = await probeMedia(sourcePath);
      if (!meta?.duration || meta.duration <= 0.05) throw new MediaError(`Rank ${entry.rank} rendered clip has no usable duration.`);
      timeline.push({ ...entry, sourcePath, startAt: elapsed, duration: meta.duration });
      elapsed += meta.duration;
    }

    /* Build and normalise the video first, then burn one persistent ranking list over it. */
    const inputArgs = timeline.flatMap((entry) => ["-i", entry.sourcePath]);
    const normalised = timeline.flatMap((_, index) => [
      `[${index}:v]fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih),setsar=1[v${index}]`,
      `[${index}:a]aresample=48000,aformat=channel_layouts=stereo[a${index}]`
    ]);
    const concatInputs = timeline.map((_, index) => `[v${index}][a${index}]`).join("");
    const filters = [...normalised, `${concatInputs}concat=n=${timeline.length}:v=1:a=1[basev][aout]`];
    let previousVideo = "[basev]";

    for (let index = 0; index < timeline.length; index += 1) {
      const entry = timeline[index];
      const rankFile = path5.join(tmpDir, `rank-number-${index}.txt`);
      const titleFile = path5.join(tmpDir, `rank-title-${index}.txt`);
      await fs6.writeFile(rankFile, entry.showNumber === false ? "" : String(entry.rank), "utf8");
      await fs6.writeFile(titleFile, entry.showTitle === false ? "" : entry.title.trim().toUpperCase().slice(0, 72), "utf8");
      const number = entry.numberPosition || { x: 0.12, y: 0.3 + index * 0.13 };
      const title = entry.titlePosition || { x: 0.42, y: 0.3 + index * 0.13 };
      const accent = /^#[0-9a-fA-F]{6}$/.test(entry.accentColor || "") ? entry.accentColor : "#a3e635";
      const numberSize = Math.max(42, Math.min(220, Math.round(entry.numberSize || 96)));
      const titleSize = Math.max(24, Math.min(112, Math.round(entry.titleSize || 56)));
      const numberOut = `[num${index}]`;
      const titleOut = `[title${index}]`;
      /* Rank numbers remain visible from the first frame. Titles reveal when their matching clip begins and remain revealed. */
      filters.push(`${previousVideo}drawtext=fontfile=${font}:textfile=${path5.basename(rankFile)}:fontcolor=${accent}:fontsize=${numberSize}:borderw=5:bordercolor=black@0.92:x=(${Math.round(number.x * 1080)})-text_w/2:y=(${Math.round(number.y * 1920)})-text_h/2${numberOut}`);
      filters.push(`${numberOut}drawtext=fontfile=${font}:textfile=${path5.basename(titleFile)}:fontcolor=white:fontsize=${titleSize}:borderw=4:bordercolor=black@0.92:x=(${Math.round(title.x * 1080)})-text_w/2:y=(${Math.round(title.y * 1920)})-text_h/2:enable='gte(t\,${entry.startAt.toFixed(3)})'${titleOut}`);
      previousVideo = titleOut;
    }

    filters.push(`${previousVideo}null[vout]`);
    const graph = filters.join(";");
    console.log(`[Top5] Composing ${timeline.length} short ranked clip${timeline.length === 1 ? "" : "s"} (${elapsed.toFixed(1)}s total) with overlay...`);
    await runStreaming(ffmpeg, [
      ...inputArgs, "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
      /* Intermediates are already 1080×1920 H.264. Medium/CRF18 preserves a
       * clean final export while avoiding the slow-preset bottleneck on Fly's
       * single shared CPU for a 15-second ranked video. */
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p", "-r", "30", "-fps_mode", "cfr", "-g", "60",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-tag:v", "avc1", "-sws_flags", "lanczos+accurate_rnd+full_chroma_int", "-threads", "1", "-y", "-loglevel", "error", outPath
    ], { timeout: 6e5, cwd: tmpDir });
    console.log(`[Top5] Composition finished for ${timeline.length} ranked clip${timeline.length === 1 ? "" : "s"}.`);
    const stat = await fs6.stat(outPath).catch(() => null);
    if (!stat || stat.size === 0) throw new MediaError("Top 5 rendering produced an empty file.");
    return { url: urlFor("clip", fileName), bytes: stat.size };
  } finally {
    await fs6.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

var appRouter = router({
  system: systemRouter,
  // ─── GEMINI AI ────────────────────────────────────────────────────────────
  gemini: geminiRouter,
  extract: extractRouter,
  // ─── AUTH ────────────────────────────────────────────────────────────────
  auth: router({
    /**
     * GET /api/trpc/auth.me
     * Returns the currently authenticated user or null.
     */
    me: publicProcedure.query((opts) => opts.ctx.user),
    /**
     * POST /api/trpc/auth.register
     * Register a new user with name, email, and password.
     * Password is hashed with bcrypt before storage.
     */
    register: publicProcedure.input(z4.object({
      name: z4.string().min(2, "Name must be at least 2 characters"),
      email: z4.string().email("Invalid email address"),
      password: z4.string().min(8, "Password must be at least 8 characters")
    })).mutation(async ({ input, ctx }) => {
      const existing = await getUserByEmail(input.email);
      if (existing) throw new TRPCError5({ code: "CONFLICT", message: "Email already in use" });
      const passwordHash = await bcrypt.hash(input.password, 12);
      const openId = `email:${nanoid(16)}`;
      await upsertUser({
        openId,
        name: input.name,
        email: input.email,
        loginMethod: "email",
        passwordHash,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const user = await getUserByEmail(input.email);
      if (!user) throw new TRPCError5({ code: "INTERNAL_SERVER_ERROR" });
      const token = await signJwt({ sub: String(user.id), openId: user.openId, appId: ENV.appId, name: user.name ?? "" }, ENV.cookieSecret);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1e3 });
      return { success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
    }),
    /**
     * POST /api/trpc/auth.login
     * Authenticate with email and password. Issues a JWT session cookie.
     */
    login: publicProcedure.input(z4.object({
      email: z4.string().email(),
      password: z4.string().min(1)
    })).mutation(async ({ input, ctx }) => {
      const user = await getUserByEmail(input.email);
      if (!user || !user.passwordHash) throw new TRPCError5({ code: "UNAUTHORIZED", message: "Invalid email or password" });
      const valid = await bcrypt.compare(input.password, user.passwordHash);
      if (!valid) throw new TRPCError5({ code: "UNAUTHORIZED", message: "Invalid email or password" });
      await updateUser(user.id, { lastSignedIn: /* @__PURE__ */ new Date() });
      const token = await signJwt({ sub: String(user.id), openId: user.openId, appId: ENV.appId, name: user.name ?? "" }, ENV.cookieSecret);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1e3 });
      return { success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
    }),
    /**
     * POST /api/trpc/auth.logout
     * Clears the session cookie and ends the user session.
     */
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true };
    })
  }),
  // ─── PROFILE ─────────────────────────────────────────────────────────────
  profile: router({
    /**
     * GET /api/trpc/profile.get
     * Returns the current user's profile information.
     */
    get: protectedProcedure.query(async ({ ctx }) => {
      const user = await getUserById(ctx.user.id);
      if (!user) throw new TRPCError5({ code: "NOT_FOUND" });
      return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt };
    }),
    /**
     * POST /api/trpc/profile.update
     * Update the current user's name and/or email.
     */
    update: protectedProcedure.input(z4.object({
      name: z4.string().min(2).optional(),
      email: z4.string().email().optional()
    })).mutation(async ({ input, ctx }) => {
      if (input.email) {
        const existing = await getUserByEmail(input.email);
        if (existing && existing.id !== ctx.user.id) throw new TRPCError5({ code: "CONFLICT", message: "Email already in use" });
      }
      await updateUser(ctx.user.id, input);
      return { success: true };
    }),
    /**
     * POST /api/trpc/profile.changePassword
     * Change the current user's password. Requires current password verification.
     */
    changePassword: protectedProcedure.input(z4.object({
      currentPassword: z4.string().min(1),
      newPassword: z4.string().min(8, "New password must be at least 8 characters")
    })).mutation(async ({ input, ctx }) => {
      const user = await getUserById(ctx.user.id);
      if (!user || !user.passwordHash) throw new TRPCError5({ code: "BAD_REQUEST", message: "No password set" });
      const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!valid) throw new TRPCError5({ code: "UNAUTHORIZED", message: "Current password is incorrect" });
      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await updateUser(ctx.user.id, { passwordHash });
      return { success: true };
    })
  }),
  // ─── VIDEOS ──────────────────────────────────────────────────────────────
  videos: router({
    /**
     * GET /api/trpc/videos.list
     * Returns all videos belonging to the current user.
     */
    list: protectedProcedure.query(async ({ ctx }) => {
      return getVideosByUser(ctx.user.id);
    }),
    /**
     * GET /api/trpc/videos.get
     * Returns a single video by ID (must belong to current user).
     */
    get: protectedProcedure.input(z4.object({ id: z4.number() })).query(async ({ input, ctx }) => {
      const video = await getVideoById(input.id, ctx.user.id);
      if (!video) throw new TRPCError5({ code: "NOT_FOUND" });
      return video;
    }),
    /**
     * POST /api/trpc/videos.create
     * Create a new video entry from a URL or upload reference.
     */
    create: protectedProcedure.input(z4.object({
      title: z4.string().min(1),
      sourceType: z4.enum(["upload", "url"]),
      sourceUrl: z4.string().optional(),
      /**
       * Persisted here because clip rendering derives burned-in captions from
       * it. Without this the transcript stayed in the browser and exports
       * came out with no subtitles.
       */
      transcript: z4.string().optional(),
      duration: z4.number().optional(),
      /**
       * Real word timings from the source caption track. Stored so burned-in
       * captions follow the speech rather than being spread evenly.
       */
      transcriptWords: z4.array(z4.object({
        word: z4.string(),
        start: z4.number(),
        end: z4.number()
      })).optional(),
      /**
       * Whether this video should have subtitles at all. Off skips every
       * speech-to-text call, so no Inworld credits are spent, and can be
       * switched on later to transcribe on demand.
       */
      transcriptionEnabled: z4.boolean().default(true)
    })).mutation(async ({ input, ctx }) => {
      const id = await createVideo({
        ...input,
        userId: ctx.user.id,
        status: input.transcript ? "done" : "pending"
      });
      return { id };
    }),
    /**
     * POST /api/trpc/videos.updateStatus
     * Update a video's processing status (pending → transcribing → analyzing → done).
     */
    updateStatus: protectedProcedure.input(z4.object({
      id: z4.number(),
      status: z4.enum(["pending", "transcribing", "analyzing", "done", "error"]),
      transcript: z4.string().optional()
    })).mutation(async ({ input, ctx }) => {
      const video = await getVideoById(input.id, ctx.user.id);
      if (!video) throw new TRPCError5({ code: "NOT_FOUND" });
      await updateVideo(input.id, { status: input.status, transcript: input.transcript });
      return { success: true };
    }),
    /**
     * POST /api/trpc/videos.host
     *
     * Downloads the source into our own storage so all preview, editing and
     * rendering run against a local file. Returns immediately; the client polls
     * `videos.get` (or `videos.list`) for `hostedStatus`.
     */
    host: protectedProcedure.input(z4.object({
      id: z4.number(),
      /** Download only this time range (seconds). Much faster than full video. */
      startTime: z4.number().min(0).optional(),
      endTime: z4.number().min(0).optional(),
      /** Replace a previously hosted short range for a live custom preview. */
      force: z4.boolean().default(false)
    })).mutation(async ({ input, ctx }) => {
      const video = await getVideoById(input.id, ctx.user.id);
      if (!video) throw new TRPCError5({ code: "NOT_FOUND", message: "Video not found" });
      if (video.hostedStatus === "downloading") {
        return { success: true, hostedStatus: "downloading", hostedUrl: null };
      }
      if (video.hostedStatus === "ready" && video.hostedUrl && !input.force) {
        return { success: true, hostedStatus: "ready", hostedUrl: video.hostedUrl };
      }
      const sourceUrl = video.sourceUrl;
      if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
        throw new TRPCError5({
          code: "BAD_REQUEST",
          message: "This video has no downloadable source URL, so it cannot be hosted."
        });
      }
      await updateVideo(video.id, { hostedStatus: "downloading", hostError: null, hostProgress: 0 });
      void (async () => {
        let lastWrite = 0;
        let lastValue = -1;
        const onProgress = (percent) => {
          const now = Date.now();
          if (percent === lastValue || now - lastWrite < 1e3) return;
          lastWrite = now;
          lastValue = percent;
          void updateVideo(video.id, { hostProgress: percent }).catch(() => {
          });
        };
        try {
          const range = input.startTime != null && input.endTime != null ? { start: input.startTime, end: input.endTime } : null;
          const result = await hostVideo({ videoId: video.id, sourceUrl, range, onProgress });
          const isLowRes = result.width > 0 && result.height > 0 && (result.width < 1280 || result.height < 720);
          const qualityState = isLowRes ? "LOW_QUALITY_FALLBACK" : "HIGH_QUALITY_SOURCE";
          await updateVideo(video.id, {
            hostedStatus: "ready",
            hostedUrl: result.url,
            hostError: isLowRes ? `Source is ${result.width}x${result.height}. Clip may appear soft when cropped to vertical. Upload original for best quality.` : null,
            hostProgress: 100,
            hostedOffset: result.offset,
            width: result.width || null,
            height: result.height || null,
            /* A selected preview range can begin at 0, but it must never
             * overwrite the original full-source duration with 15 seconds. */
            ...!range && result.duration ? { duration: result.duration } : {}
          });
          console.log(
            `[Host] Video ${video.id} hosted (${Math.round(result.bytes / 1024 / 1024)} MB, ${result.width}x${result.height}, quality=${qualityState}) \u2192 ${result.url}`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Host] Video ${video.id} failed: ${msg}`);
          await updateVideo(video.id, {
            hostedStatus: "error",
            hostError: msg.slice(0, 500)
          }).catch(() => {
          });
        }
      })();
      return { success: true, hostedStatus: "downloading", hostedUrl: null };
    })
  }),
  // ─── CLIPS ───────────────────────────────────────────────────────────────
  clips: router({
    /**
     * GET /api/trpc/clips.list
     * Returns all clips for the current user across all videos.
     */
    list: protectedProcedure.query(async ({ ctx }) => {
      return getClipsByUser(ctx.user.id);
    }),
    /**
     * GET /api/trpc/clips.listByVideo
     * Returns all clips for a specific video.
     */
    listByVideo: protectedProcedure.input(z4.object({ videoId: z4.number() })).query(async ({ input, ctx }) => {
      return getClipsByVideo(input.videoId, ctx.user.id);
    }),
    /**
     * POST /api/trpc/clips.create
     * Create a new clip entry from AI highlight detection results.
     */
    create: protectedProcedure.input(z4.object({
      videoId: z4.number(),
      title: z4.string(),
      startTime: z4.number(),
      endTime: z4.number(),
      engagementScore: z4.number().optional()
    })).mutation(async ({ input, ctx }) => {
      const id = await createClip({ ...input, userId: ctx.user.id, status: "pending" });
      return { id };
    }),
    /**
     * POST /api/trpc/clips.update
     * Live-edit a clip's title and in/out points.
     */
    update: protectedProcedure.input(z4.object({
      id: z4.number(),
      title: z4.string().min(1).optional(),
      startTime: z4.number().min(0).optional(),
      endTime: z4.number().min(0).optional(),
      // Reframing set by dragging/zooming the preview.
      zoom: z4.number().min(0.1).max(10).optional(),
      offsetX: z4.number().min(-1).max(1).optional(),
      offsetY: z4.number().min(-1).max(1).optional(),
      /** Burn subtitles into the export, or leave the clip clean. */
      captionsEnabled: z4.boolean().optional(),
      /**
       * Time-varying framing in clip-relative seconds. An empty array clears
       * it back to the single framing above.
       */
      framingSegments: z4.array(z4.object({
        start: z4.number().min(0),
        end: z4.number().min(0),
        zoom: z4.number().min(0.1).max(10),
        offsetX: z4.number().min(-1).max(1),
        offsetY: z4.number().min(-1).max(1),
        /*
         * Framing reached at the end of the segment. When given, the crop
         * moves towards it across the segment rather than holding still,
         * which is what makes a zoom glide instead of snap.
         */
        to: z4.object({
          zoom: z4.number().min(0.1).max(10),
          offsetX: z4.number().min(-1).max(1),
          offsetY: z4.number().min(-1).max(1)
        }).nullish(),
        /** Curve for that movement. */
        ease: z4.enum(["linear", "in", "out", "inOut"]).optional(),
        /*
         * The slice of that curve this segment renders, set when a moving
         * segment has been split so each piece keeps the original pacing.
         */
        easeFrom: z4.number().min(0).max(1).optional(),
        easeTo: z4.number().min(0).max(1).optional()
      })).optional()
    })).mutation(async ({ input, ctx }) => {
      const owned = await getClipsByUser(ctx.user.id);
      const clip = owned.find((c) => c.id === input.id);
      if (!clip) throw new TRPCError5({ code: "NOT_FOUND", message: "Clip not found" });
      const startTime = input.startTime ?? clip.startTime ?? 0;
      const endTime = input.endTime ?? clip.endTime ?? 0;
      if (endTime <= startTime) {
        throw new TRPCError5({ code: "BAD_REQUEST", message: "End time must be after start time" });
      }
      await updateClip(input.id, {
        ...input.title !== void 0 ? { title: input.title } : {},
        ...input.startTime !== void 0 ? { startTime } : {},
        ...input.endTime !== void 0 ? { endTime } : {},
        ...input.zoom !== void 0 ? { zoom: input.zoom } : {},
        ...input.offsetX !== void 0 ? { offsetX: input.offsetX } : {},
        ...input.offsetY !== void 0 ? { offsetY: input.offsetY } : {},
        ...input.captionsEnabled !== void 0 ? { captionsEnabled: input.captionsEnabled } : {},
        // An empty array means "no timeline", stored as null.
        ...input.framingSegments !== void 0 ? { framingSegments: input.framingSegments.length > 0 ? input.framingSegments : null } : {}
      });
      return { success: true, startTime, endTime };
    }),
    /**
     * POST /api/trpc/clips.render
     *
     * Cuts the clip out of the video we already host, applying the saved
     * zoom/pan crop. Returns immediately; the clip's status moves
     * rendering → done|error and clients poll `clips.list`.
     *
     * Requires the video to be hosted first (`videos.host`).
     */
    render: protectedProcedure.input(z4.object({
      id: z4.number(),
      // Allow the caller to render the framing currently on screen without
      // needing a separate save round-trip.
      zoom: z4.number().min(0.1).max(10).optional(),
      offsetX: z4.number().min(-1).max(1).optional(),
      offsetY: z4.number().min(-1).max(1).optional(),
      /** Top-and-bottom letterbox color used by horizontal zoom-out. */
      barColor: z4.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      /** Overrides the clip's saved setting for this render. */
      captionsEnabled: z4.boolean().optional(),
      /** Optimized intermediate profile used only by the ranked-video builder. */
      renderProfile: z4.enum(["top5"]).optional()
    })).mutation(async ({ input, ctx }) => {
      const owned = await getClipsByUser(ctx.user.id);
      const clip = owned.find((c) => c.id === input.id);
      if (!clip) throw new TRPCError5({ code: "NOT_FOUND", message: "Clip not found" });
      if (clip.startTime == null || clip.endTime == null || clip.endTime <= clip.startTime) {
        throw new TRPCError5({ code: "BAD_REQUEST", message: "Set a valid start and end time before rendering." });
      }
      const captionsEnabled = input.captionsEnabled ?? clip.captionsEnabled ?? true;
      const renderProfile = input.renderProfile === "top5" ? "top5" : "standard";
      const video = await getVideoById(clip.videoId, ctx.user.id);
      if (!video) throw new TRPCError5({ code: "NOT_FOUND", message: "This clip's video no longer exists." });
      const hostedPath = localPathFromUrl(video.hostedUrl);
      if (video.hostedStatus !== "ready" || !hostedPath) {
        /*
         * Auto-import just this clip's range at full quality.
         * Much faster than downloading the entire video.
         */
        if (video.hostedStatus === "downloading") {
          throw new TRPCError5({
            code: "PRECONDITION_FAILED",
            message: "The video is still being imported. Wait for it to finish, then render."
          });
        }
        const sourceUrl = video.sourceUrl;
        if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
          throw new TRPCError5({ code: "BAD_REQUEST", message: "No downloadable source URL for this video." });
        }
        console.log(`[Render] Auto-importing clip range ${clip.startTime}-${clip.endTime}s for clip ${clip.id}...`);
        await updateVideo(video.id, { hostedStatus: "downloading", hostError: null, hostProgress: 0 });
        try {
          const result = await hostVideo({
            videoId: video.id,
            sourceUrl,
            range: { start: clip.startTime, end: clip.endTime },
            maxHeight: 2160,
            onProgress: (pct) => { void updateVideo(video.id, { hostProgress: pct }).catch(() => {}); }
          });
          await updateVideo(video.id, {
            hostedStatus: "ready",
            hostedUrl: result.url,
            hostProgress: 100,
            hostedOffset: result.offset,
            width: result.width || null,
            height: result.height || null,
          });
          console.log(`[Render] Auto-import done: ${Math.round(result.bytes / 1024 / 1024)}MB ${result.width}x${result.height}`);
          /* Re-read the video to get the updated path */
          const updatedVideo = await getVideoById(video.id, ctx.user.id);
          var actualHostedPath = localPathFromUrl(updatedVideo.hostedUrl);
          var actualHostedOffset = updatedVideo.hostedOffset ?? 0;
        } catch (importErr) {
          const msg = importErr instanceof Error ? importErr.message : String(importErr);
          await updateVideo(video.id, { hostedStatus: "error", hostError: msg.slice(0, 500) }).catch(() => {});
          throw new TRPCError5({ code: "INTERNAL_SERVER_ERROR", message: `Auto-import failed: ${msg}` });
        }
      } else {
        var actualHostedPath = hostedPath;
        var actualHostedOffset = video.hostedOffset ?? 0;
      }
      const crop = {
        zoom: input.zoom ?? clip.zoom ?? DEFAULT_CROP.zoom,
        offsetX: input.offsetX ?? clip.offsetX ?? DEFAULT_CROP.offsetX,
        offsetY: input.offsetY ?? clip.offsetY ?? DEFAULT_CROP.offsetY,
        barColor: input.barColor ?? "#000000"
      };
      await updateClip(clip.id, {
        status: "rendering",
        errorMessage: null,
        zoom: crop.zoom,
        offsetX: crop.offsetX,
        offsetY: crop.offsetY,
        captionsEnabled
      });
      /*
       * Always transcribe the clip's own audio for subtitles.
       * This gives much better lip sync than YouTube captions which have
       * 3-7s segment-level timing that drifts from actual speech.
       */
      var finalCaptions = null;
      if (captionsEnabled && actualHostedPath) {
        console.log(`[Render] Transcribing clip ${clip.id} audio for subtitles (${(clip.endTime - clip.startTime).toFixed(0)}s)...`);
        const apiKey = process.env.INWORLD_API_KEY;
        if (apiKey) {
          const clipTmpDir = await fs6.mkdtemp(path5.join(os3.tmpdir(), `shortspro-clip-stt-${clip.id}-`));
          try {
            const ffmpegBin = await findFfmpeg();
            const clipAudio = path5.join(clipTmpDir, "clip.mp3");
            const seekStart = Math.max(0, clip.startTime - actualHostedOffset);
            const seekDur = clip.endTime - clip.startTime;
            await execAsync(
              `${q(ffmpegBin)} -ss ${seekStart.toFixed(3)} -t ${seekDur.toFixed(3)} -i ${q(actualHostedPath)} -vn -ar 16000 -ac 1 -b:a 64k ${q(clipAudio)} -y -loglevel error`,
              { timeout: 6e4 }
            );
            /*
             * Real per-word timings first. faster-whisper reports an actual
             * start/end for every word, so captions land on the syllable
             * instead of being spread across a guessed region.
             */
            let localWords = [];
            try {
              const local = await localWhisperWords(clipAudio, "en");
              localWords = local.words;
              if (localWords.length > 0) {
                finalCaptions = { words: localWords, style: DEFAULT_CAPTION_STYLE };
                try {
                  const existing = await db.select().from(subtitles).where(eq(subtitles.clipId, clip.id));
                  const payload = JSON.stringify(localWords.map((w) => ({ ...w, start: w.start + clip.startTime, end: w.end + clip.startTime })));
                  if (existing.length > 0) {
                    await db.update(subtitles).set({ words: payload }).where(eq(subtitles.clipId, clip.id));
                  } else {
                    await db.insert(subtitles).values({ clipId: clip.id, userId: ctx.user.id, words: payload });
                  }
                } catch {}
                console.log(`[Render] Clip ${clip.id}: ${localWords.length} words with real per-word timings (faster-whisper)`);
              }
            } catch (localErr) {
              console.warn(`[Render] Local word timing unavailable, falling back to Inworld + estimated timing: ${localErr instanceof Error ? localErr.message : String(localErr)}`);
            }
            /*
             * Fallback only. Inworld returns no word timings, so the positions
             * below are estimated from silence regions and will drift.
             */
            const fullText = localWords.length > 0 ? "" : await inworldTranscribe(clipAudio, apiKey, "en");
            const fullClean = localWords.length > 0 ? "" : cleanCaptionText(fullText);
            if (!fullClean) {
              if (localWords.length === 0) console.warn(`[Render] Clip ${clip.id}: STT returned empty text`);
            } else {
              const allWords = splitWords(fullClean);
              /* Step 2: Detect speech regions */
              const silOutput = await execAsync(`${q(ffmpegBin)} -i ${q(clipAudio)} -af "silencedetect=noise=-30dB:d=0.3" -f null - 2>&1`, {
                timeout: 6e4, maxBuffer: 32 * 1024 * 1024
              }).catch((e) => ({ stdout: e?.stdout ?? "", stderr: e?.stderr ?? "" }));
              const silBlob = `${silOutput.stdout ?? ""}${silOutput.stderr ?? ""}`;
              const silStarts = [], silEndsArr = [];
              for (const line of silBlob.split(/\r?\n/)) {
                const sm = /silence_start:\s*(-?[\d.]+)/.exec(line);
                if (sm) silStarts.push(Math.max(0, +sm[1]));
                const em = /silence_end:\s*(-?[\d.]+)/.exec(line);
                if (em) silEndsArr.push(Math.max(0, +em[1]));
              }
              const silences = silStarts.map((s, i) => ({ start: s, end: silEndsArr[i] ?? seekDur })).filter(x => x.end > x.start);
              const speechRuns = [];
              let cur = 0;
              for (const sil of silences) { if (sil.start > cur) speechRuns.push({ start: cur, end: sil.start }); cur = Math.max(cur, sil.end); }
              if (cur < seekDur) speechRuns.push({ start: cur, end: seekDur });
              /* Merge short gaps, drop slivers, trim start by 0.15s */
              const merged = [];
              for (const sp of speechRuns) {
                const trimmed = { start: Math.min(sp.start + 0.15, sp.end), end: sp.end };
                if (trimmed.end - trimmed.start < 0.2) continue;
                const l = merged[merged.length - 1];
                if (l && trimmed.start - l.end < 0.5) l.end = trimmed.end;
                else merged.push({...trimmed});
              }
              /* Step 3: Distribute words across regions proportionally by duration */
              const totalSpeechDur = merged.reduce((s, r) => s + (r.end - r.start), 0);
              const clipWords = [];
              let wordCursor = 0;
              for (let ri = 0; ri < merged.length; ri++) {
                const run = merged[ri];
                const runDur = run.end - run.start;
                const proportion = totalSpeechDur > 0 ? runDur / totalSpeechDur : 1 / merged.length;
                /* How many words belong to this region */
                const wordsForRun = ri === merged.length - 1
                  ? allWords.slice(wordCursor)
                  : allWords.slice(wordCursor, wordCursor + Math.round(proportion * allWords.length));
                wordCursor += wordsForRun.length;
                if (wordsForRun.length === 0) continue;
                /* Step 4: Split region into max 3s sub-chunks for tighter timing */
                const MAX_CHUNK = 3;
                const numChunks = Math.ceil(runDur / MAX_CHUNK);
                const chunkDur = runDur / numChunks;
                const wordsPerChunk = Math.ceil(wordsForRun.length / numChunks);
                for (let ci = 0; ci < numChunks; ci++) {
                  const chunkStart = run.start + ci * chunkDur;
                  const chunkEnd = ci === numChunks - 1 ? run.end : chunkStart + chunkDur;
                  const chunkWords = wordsForRun.slice(ci * wordsPerChunk, (ci + 1) * wordsPerChunk);
                  if (chunkWords.length === 0) continue;
                  for (const w of distributeWords(chunkWords, chunkStart, chunkEnd)) clipWords.push(w);
                }
              }
              if (clipWords.length > 0) {
                finalCaptions = { words: clipWords, style: DEFAULT_CAPTION_STYLE };
                /* Save to subtitles table so Edit section can show them too */
                try {
                  const existing = await db.select().from(subtitles).where(eq(subtitles.clipId, clip.id));
                  if (existing.length > 0) {
                    await db.update(subtitles).set({ words: JSON.stringify(clipWords) }).where(eq(subtitles.clipId, clip.id));
                  } else {
                    await db.insert(subtitles).values({ clipId: clip.id, userId: ctx.user.id, words: JSON.stringify(clipWords) });
                  }
                } catch {}
                console.log(`[Render] Clip ${clip.id}: ${clipWords.length} words across ${merged.length} speech regions (${totalSpeechDur.toFixed(1)}s speech of ${seekDur.toFixed(1)}s)`);
              }
            }
          } catch (sttErr) {
            console.warn(`[Render] Clip STT failed: ${sttErr instanceof Error ? sttErr.message : String(sttErr)}`);
          } finally {
            await fs6.rm(clipTmpDir, { recursive: true, force: true }).catch(() => {});
          }
        }
      }
      if (!finalCaptions && captionsEnabled) {
        finalCaptions = await captionsForClip(clip, video);
      }
      if (captionsEnabled && !finalCaptions) {
        console.warn(
          `[Render] Clip ${clip.id} has no captions to burn in (video ${video.id} transcript ${video.transcript ? "present" : "missing"})`
        );
      }
      void (async () => {
        try {
          const result = await renderClipFromHosted({
            clipId: clip.id,
            hostedPath: actualHostedPath,
            startTime: clip.startTime,
            endTime: clip.endTime,
            hostedOffset: actualHostedOffset,
            crop,
            // Time-varying framing, when the clip has a timeline.
            segments: clip.framingSegments,
            captions: finalCaptions,
            renderProfile
          });
          await updateClip(clip.id, {
            status: "done",
            downloadUrl: result.url,
            // Surface a font substitution as a visible note rather than
            // letting the export silently disagree with the preview.
            errorMessage: result.fontWarning ?? null
          });
          console.log(`[Render] Clip ${clip.id} ready (${Math.round(result.bytes / 1024)} KB) \u2192 ${result.url}`);
          /* Quality metadata logging */
          console.log("[Render quality]", JSON.stringify({
            clipId: clip.id,
            input: { width: video.width, height: video.height },
            output: { bytes: result.bytes, url: result.url },
            zoom: crop.zoom,
            isLowResSource: !!(video.width && video.height && (video.width < 1280 || video.height < 720))
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          /* If the clip is beyond the current import, re-import just this clip's range and retry */
          if (msg.startsWith("CLIP_BEYOND_IMPORT:")) {
            const sourceUrl = video.sourceUrl;
            if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
              console.log(`[Render] Clip ${clip.id} beyond current import — re-importing range ${clip.startTime}-${clip.endTime}s`);
              try {
                await updateVideo(video.id, { hostedStatus: "downloading", hostProgress: 0 });
                const reResult = await hostVideo({
                  videoId: video.id,
                  sourceUrl,
                  range: { start: clip.startTime, end: clip.endTime },
                  maxHeight: 2160,
                  onProgress: () => {}
                });
                await updateVideo(video.id, {
                  hostedStatus: "ready",
                  hostedUrl: reResult.url,
                  hostProgress: 100,
                  hostedOffset: reResult.offset,
                  width: reResult.width || null,
                  height: reResult.height || null,
                });
                const reHostedPath = localPathFromUrl(reResult.url);
                const reResult2 = await renderClipFromHosted({
                  clipId: clip.id,
                  hostedPath: reHostedPath,
                  startTime: clip.startTime,
                  endTime: clip.endTime,
                  hostedOffset: reResult.offset,
                  crop,
                  segments: clip.framingSegments,
                  captions: finalCaptions,
                  renderProfile
                });
                await updateClip(clip.id, {
                  status: "done",
                  downloadUrl: reResult2.url,
                  errorMessage: reResult2.fontWarning ?? null
                });
                console.log(`[Render] Clip ${clip.id} ready after re-import (${Math.round(reResult2.bytes / 1024)} KB)`);
                return;
              } catch (reErr) {
                const reMsg = reErr instanceof Error ? reErr.message : String(reErr);
                console.error(`[Render] Clip ${clip.id} re-import+render failed: ${reMsg}`);
                await updateClip(clip.id, { status: "error", errorMessage: reMsg.slice(0, 500) }).catch(() => {});
                return;
              }
            }
          }
          console.error(`[Render] Clip ${clip.id} failed: ${msg}`);
          await updateClip(clip.id, { status: "error", errorMessage: msg.slice(0, 500) }).catch(() => {
          });
        }
      })();
      return { success: true, status: "rendering" };
    }),
    /**
     * POST /api/trpc/clips.transcribe
     *
     * Runs speech-to-text over the clip's own audio and stores the resulting
     * word timings, giving captions that track the speech.
     *
     * This is preferred over a source caption track: those repeat words in
     * rolling cues and their timings mark publication, not speech, so captions
     * appear in silence and linger after the speaker stops.
     */
    transcribe: protectedProcedure.input(z4.object({
      id: z4.number(),
      apiKey: z4.string().min(1, "Inworld API key is required"),
      language: z4.string().default("en"),
      /**
       * Transcribe even though the video has subtitles switched off, and turn
       * them on. Used by the explicit "generate transcript now" action.
       */
      force: z4.boolean().default(false)
    })).mutation(async ({ input, ctx }) => {
      const clip = await getClipById(input.id, ctx.user.id);
      if (!clip) throw new TRPCError5({ code: "NOT_FOUND", message: "Clip not found" });
      if (clip.startTime == null || clip.endTime == null || clip.endTime <= clip.startTime) {
        throw new TRPCError5({ code: "BAD_REQUEST", message: "Set a valid start and end time first." });
      }
      const video = await getVideoById(clip.videoId, ctx.user.id);
      const hostedPath = localPathFromUrl(video?.hostedUrl);
      if (!video || video.hostedStatus !== "ready" || !hostedPath) {
        throw new TRPCError5({
          code: "PRECONDITION_FAILED",
          message: "Import the video first \u2014 transcription reads the clip's audio from it."
        });
      }
      if (!video.transcriptionEnabled && !input.force) {
        throw new TRPCError5({
          code: "PRECONDITION_FAILED",
          message: "Subtitles are turned off for this video. Enable them to transcribe."
        });
      }
      const offset = video.hostedOffset ?? 0;
      const localStart = Math.max(0, clip.startTime - offset);
      const duration = clip.endTime - clip.startTime;
      let audioPath = null;
      try {
        audioPath = await extractAudioRange(hostedPath, localStart, duration);
        const resolvedKey = (input.apiKey && input.apiKey !== "server" ? input.apiKey : process.env.INWORLD_API_KEY || input.apiKey);
        /*
         * Real per-word timings first, so the editor shows captions on the
         * syllable rather than estimated positions.
         */
        try {
          const local = await localWhisperWords(audioPath, input.language);
          if (local.words.length > 0) {
            const absolute = local.words.map((w) => ({
              word: w.word,
              start: w.start + clip.startTime,
              end: w.end + clip.startTime
            }));
            await recordSttUsage(video.id, duration);
            const existingSub = await getSubtitleByClip(clip.id);
            await upsertSubtitle({
              clipId: clip.id,
              userId: ctx.user.id,
              style: existingSub?.style ?? void 0,
              words: absolute
            });
            if (input.force && !video.transcriptionEnabled) {
              await updateVideo(video.id, { transcriptionEnabled: true });
            }
            console.log(`[STT] Clip ${clip.id}: ${absolute.length} words with real per-word timings (faster-whisper)`);
            return {
              success: true,
              wordCount: absolute.length,
              timed: true,
              text: local.text,
              words: absolute
            };
          }
        } catch (localErr) {
          console.warn(`[STT] Local word timing unavailable, falling back to Inworld + estimated timing: ${localErr instanceof Error ? localErr.message : String(localErr)}`);
        }
        /* Fallback: Inworld text with timings estimated from silence regions. */
        const fullText = await inworldTranscribe(audioPath, resolvedKey, input.language);
        const cleanText = cleanCaptionText(fullText);
        if (!cleanText) {
          throw new TRPCError5({
            code: "INTERNAL_SERVER_ERROR",
            message: "No speech was detected in this clip."
          });
        }
        const allWords = splitWords(cleanText);
        /* Detect speech regions for timing alignment */
        const ffmpegBin = await findFfmpeg();
        const silOutput = await execAsync(`${q(ffmpegBin)} -i ${q(audioPath)} -af "silencedetect=noise=-30dB:d=0.3" -f null - 2>&1`, {
          timeout: 6e4, maxBuffer: 32 * 1024 * 1024
        }).catch((e) => ({ stdout: e?.stdout ?? "", stderr: e?.stderr ?? "" }));
        const silBlob = `${silOutput.stdout ?? ""}${silOutput.stderr ?? ""}`;
        const silStarts = [], silEndsArr = [];
        for (const line of silBlob.split(/\r?\n/)) {
          const sm = /silence_start:\s*(-?[\d.]+)/.exec(line);
          if (sm) silStarts.push(Math.max(0, +sm[1]));
          const em = /silence_end:\s*(-?[\d.]+)/.exec(line);
          if (em) silEndsArr.push(Math.max(0, +em[1]));
        }
        const silences = silStarts.map((s, i) => ({ start: s, end: silEndsArr[i] ?? duration })).filter(x => x.end > x.start);
        const speechRuns = [];
        let cur2 = 0;
        for (const sil of silences) { if (sil.start > cur2) speechRuns.push({ start: cur2, end: sil.start }); cur2 = Math.max(cur2, sil.end); }
        if (cur2 < duration) speechRuns.push({ start: cur2, end: duration });
        const merged = [];
        for (const sp of speechRuns) {
          const trimmed = { start: Math.min(sp.start + 0.15, sp.end), end: sp.end };
          if (trimmed.end - trimmed.start < 0.2) continue;
          const l = merged[merged.length - 1];
          if (l && trimmed.start - l.end < 0.5) l.end = trimmed.end;
          else merged.push({...trimmed});
        }
        /* Distribute words across speech regions with 3s sub-chunks */
        const totalSpeechDur = merged.reduce((s, r) => s + (r.end - r.start), 0);
        const timedWords = [];
        let wordCursor = 0;
        for (let ri = 0; ri < merged.length; ri++) {
          const run = merged[ri];
          const runDur = run.end - run.start;
          const proportion = totalSpeechDur > 0 ? runDur / totalSpeechDur : 1 / merged.length;
          const wordsForRun = ri === merged.length - 1
            ? allWords.slice(wordCursor)
            : allWords.slice(wordCursor, wordCursor + Math.round(proportion * allWords.length));
          wordCursor += wordsForRun.length;
          if (wordsForRun.length === 0) continue;
          const MAX_CHUNK = 3;
          const numChunks = Math.ceil(runDur / MAX_CHUNK);
          const chunkDur = runDur / numChunks;
          const wordsPerChunk = Math.ceil(wordsForRun.length / numChunks);
          for (let ci = 0; ci < numChunks; ci++) {
            const chunkStart = run.start + ci * chunkDur;
            const chunkEnd = ci === numChunks - 1 ? run.end : chunkStart + chunkDur;
            const chunkWords = wordsForRun.slice(ci * wordsPerChunk, (ci + 1) * wordsPerChunk);
            if (chunkWords.length === 0) continue;
            for (const w of distributeWords(chunkWords, chunkStart + clip.startTime, chunkEnd + clip.startTime)) timedWords.push(w);
          }
        }
        await recordSttUsage(video.id, duration);
        console.log(
          `[STT] Clip ${clip.id} (video ${video.id}): ${duration.toFixed(1)}s audio, ${timedWords.length} words aligned to ${merged.length} speech regions`
        );
        const existing = await getSubtitleByClip(clip.id);
        await upsertSubtitle({
          clipId: clip.id,
          userId: ctx.user.id,
          style: existing?.style ?? void 0,
          words: timedWords.length > 0 ? timedWords : void 0
        });
        if (input.force && !video.transcriptionEnabled) {
          await updateVideo(video.id, { transcriptionEnabled: true });
        }
        return {
          success: true,
          wordCount: timedWords.length,
          timed: true,
          text: cleanText,
          words: timedWords
        };
      } catch (err) {
        if (err instanceof TRPCError5) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new TRPCError5({ code: "INTERNAL_SERVER_ERROR", message: `Transcription failed: ${msg}` });
      } finally {
        if (audioPath) await cleanupAudio(audioPath);
      }
    }),
    /**
     * POST /api/trpc/clips.delete
     * Removes a clip, its subtitles, and its rendered file.
     */
    delete: protectedProcedure.input(z4.object({ id: z4.number() })).mutation(async ({ input, ctx }) => {
      const clip = await getClipById(input.id, ctx.user.id);
      if (!clip) throw new TRPCError5({ code: "NOT_FOUND", message: "Clip not found" });
      const renderedPath = localPathFromUrl(clip.downloadUrl);
      if (renderedPath) {
        await fsp.rm(renderedPath, { force: true }).catch((err) => {
          console.warn(`[Clips] Could not delete ${renderedPath}: ${String(err)}`);
        });
      }
      await deleteClip(clip.id);
      return { success: true };
    }),
    /**
     * POST /api/trpc/clips.updateStatus
     * Update a clip's rendering status and optional download URL.
     */
    updateStatus: protectedProcedure.input(z4.object({
      id: z4.number(),
      status: z4.enum(["pending", "rendering", "done", "error"]),
      downloadUrl: z4.string().optional(),
      thumbnailUrl: z4.string().optional()
    })).mutation(async ({ input, ctx }) => {
      await updateClip(input.id, { status: input.status, downloadUrl: input.downloadUrl, thumbnailUrl: input.thumbnailUrl });
      return { success: true };
    })
  }),
  // ─── TOP 5 RANKED VIDEO ─────────────────────────────────────────────────
  top5: router({
    compose: protectedProcedure.input(z4.object({
      entries: z4.array(z4.object({
        clipId: z4.number().int().positive(),
        rank: z4.number().int().min(1).max(99),
        title: z4.string().max(72).default(""),
        showNumber: z4.boolean().default(true),
        showTitle: z4.boolean().default(true),
        numberPosition: z4.object({ x: z4.number().min(0).max(1), y: z4.number().min(0).max(1) }).optional(),
        titlePosition: z4.object({ x: z4.number().min(0).max(1), y: z4.number().min(0).max(1) }).optional(),
        accentColor: z4.string().max(16).default("#a3e635"),
        numberSize: z4.number().min(42).max(220).default(96),
        titleSize: z4.number().min(24).max(112).default(56)
      })).min(1).max(5)
    })).mutation(async ({ input, ctx }) => {
      const owned = await getClipsByUser(ctx.user.id);
      const entries = input.entries.map((entry) => {
        const clip = owned.find((item) => item.id === entry.clipId);
        if (!clip || clip.status !== "done" || !clip.downloadUrl) {
          throw new TRPCError5({ code: "PRECONDITION_FAILED", message: `Rank ${entry.rank} is not rendered yet. Render each selected clip before creating the Top 5 video.` });
        }
        const clipDuration = (clip.endTime ?? 0) - (clip.startTime ?? 0);
        if (!Number.isFinite(clipDuration) || clipDuration <= 0 || clipDuration > 15.1) {
          throw new TRPCError5({ code: "BAD_REQUEST", message: `Rank ${entry.rank} must use a clip of 15 seconds or less.` });
        }
        return { ...entry, downloadUrl: clip.downloadUrl };
      }).sort((a, b) => b.rank - a.rank);
      const result = await renderTop5Countdown(entries);
      console.log(`[Top5] Rendered ${entries.length} ranked clips (${Math.round(result.bytes / 1024 / 1024)} MB) → ${result.url}`);
      return { success: true, ...result };
    })
  }),
  // ─── SUBTITLES ───────────────────────────────────────────────────────────
  subtitles: router({
    /**
     * GET /api/trpc/subtitles.get
     * Returns subtitle data for a specific clip.
     */
    get: protectedProcedure.input(z4.object({ clipId: z4.number() })).query(async ({ input }) => {
      return getSubtitleByClip(input.clipId);
    }),
    /**
     * POST /api/trpc/subtitles.save
     * Save or update subtitle words and style settings for a clip.
     */
    save: protectedProcedure.input(z4.object({
      clipId: z4.number(),
      words: z4.array(z4.object({
        word: z4.string(),
        start: z4.number(),
        end: z4.number(),
        // Per-caption position override, percent of frame (0-100).
        posX: z4.number().min(0).max(100).optional(),
        posY: z4.number().min(0).max(100).optional()
      })).optional(),
      style: z4.object({
        font: z4.string().optional(),
        fontSize: z4.number().optional(),
        color: z4.string().optional(),
        highlightColor: z4.string().optional(),
        position: z4.enum(["top", "center", "bottom"]).optional(),
        outline: z4.boolean().optional(),
        /**
         * Free position as a percentage of the frame. Stored instead of pixels
         * so it renders identically at any output size or aspect ratio.
         */
        posX: z4.number().min(0).max(100).optional(),
        posY: z4.number().min(0).max(100).optional()
      }).optional()
    })).mutation(async ({ input, ctx }) => {
      await upsertSubtitle({ clipId: input.clipId, userId: ctx.user.id, words: input.words, style: input.style });
      return { success: true };
    })
  })
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/vite.ts
import express from "express";
import fs8 from "fs";
import { nanoid as nanoid2 } from "nanoid";
import path7 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs7 from "node:fs";
import path6 from "node:path";
import { defineConfig } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path6.join(PROJECT_ROOT, ".manus-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs7.existsSync(LOG_DIR)) {
    fs7.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs7.existsSync(logPath) || fs7.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs7.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs7.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path6.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs7.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginManusDebugCollector() {
  return {
    name: "manus-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
var plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()];
var vite_config_default = defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path6.resolve(import.meta.dirname, "client", "src"),
      "@shared": path6.resolve(import.meta.dirname, "shared"),
      "@assets": path6.resolve(import.meta.dirname, "attached_assets")
    }
  },
  envDir: path6.resolve(import.meta.dirname),
  root: path6.resolve(import.meta.dirname, "client"),
  publicDir: path6.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path6.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1"
    ],
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/_core/vite.ts
async function setupVite(app, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path7.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs8.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid2()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path7.resolve(import.meta.dirname, "../..", "dist", "public") : path7.resolve(import.meta.dirname, "public");
  if (!fs8.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app.use(express.static(distPath));
  app.use("*", (_req, res) => {
    res.sendFile(path7.resolve(distPath, "index.html"));
  });
}

// server/_core/index.ts
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}
async function findAvailablePort(startPort = 3e3) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}
async function startServer() {
  try {
    const { videos: videos2, clips: clips2 } = await resetOrphanedJobs();
    if (videos2 > 0 || clips2 > 0) {
      console.log(`[Startup] Reset ${videos2} interrupted import(s) and ${clips2} interrupted render(s)`);
    }
  } catch (err) {
    console.warn("[Startup] Could not reset interrupted jobs:", err);
  }
  const app = express2();
  const server = createServer(app);
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerMediaRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
startServer().catch(console.error);
