import { int, mysqlEnum, mysqlTable, text, longtext, timestamp, varchar, float, json, boolean } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Custom auth: email used as unique identifier */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  passwordHash: varchar("passwordHash", { length: 255 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const videos = mysqlTable("videos", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  title: varchar("title", { length: 512 }),
  sourceType: mysqlEnum("sourceType", ["upload", "url"]).notNull(),
  sourceUrl: text("sourceUrl"),
  status: mysqlEnum("status", ["pending", "transcribing", "analyzing", "done", "error"]).default("pending").notNull(),
  duration: float("duration"),
  transcript: longtext("transcript"),
  /**
   * Word-level timings from the source caption track, when it had them.
   * Shape: [{ word, start, end }] in absolute video seconds. Present only for
   * sources with real timestamps; otherwise captions are spread by length.
   */
  transcriptWords: json("transcriptWords"),
  /**
   * Whether the user wants subtitles for this video.
   *
   * Off means no speech-to-text is performed anywhere in the pipeline — no
   * Inworld credits are spent — and the transcript-dependent highlight step is
   * skipped. It can be turned on later, which transcribes on demand.
   */
  transcriptionEnabled: boolean("transcriptionEnabled").default(true).notNull(),
  /** Number of speech-to-text requests billed against this video. */
  sttCalls: int("sttCalls").default(0).notNull(),
  /** Total audio seconds sent for speech-to-text, for cost monitoring. */
  sttSeconds: float("sttSeconds").default(0).notNull(),
  /**
   * Local hosting. The source is downloaded to our own storage so all preview,
   * editing and rendering runs against our file rather than an external player.
   */
  hostedStatus: mysqlEnum("hostedStatus", ["none", "downloading", "ready", "error"]).default("none").notNull(),
  /** Path served by /api/media/video/<name> once hosting completes. */
  hostedUrl: text("hostedUrl"),
  /** 0-100 while downloading, so the UI can show real progress. */
  hostProgress: int("hostProgress").default(0).notNull(),
  /**
   * Original-video time (seconds) corresponding to t=0 in the hosted file.
   *
   * Partial imports download only a section, so the hosted file's timeline is
   * shifted relative to the source. Clip times are stored as absolute source
   * times, so this offset must be subtracted before seeking into the hosted
   * file. 0 for a full import.
   */
  hostedOffset: float("hostedOffset").default(0).notNull(),
  /** Native pixel size of the hosted file, used to seed the reframing UI. */
  width: int("width"),
  height: int("height"),
  hostError: text("hostError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Video = typeof videos.$inferSelect;
export type InsertVideo = typeof videos.$inferInsert;

export const clips = mysqlTable("clips", {
  id: int("id").autoincrement().primaryKey(),
  videoId: int("videoId").notNull(),
  userId: int("userId").notNull(),
  title: varchar("title", { length: 512 }),
  startTime: float("startTime"),
  endTime: float("endTime"),
  engagementScore: float("engagementScore"),
  status: mysqlEnum("status", ["pending", "rendering", "done", "error"]).default("pending").notNull(),
  downloadUrl: text("downloadUrl"),
  thumbnailUrl: text("thumbnailUrl"),
  /** Why the last render failed, surfaced to the user. Cleared on success. */
  errorMessage: text("errorMessage"),
  /**
   * Reframing for the vertical crop, set by dragging/zooming the preview.
   * zoom 1 = fit the source width; offsets are -1..1 fractions of the slack
   * remaining after zooming, so 0,0 is always centred.
   */
  zoom: float("zoom").default(1).notNull(),
  offsetX: float("offsetX").default(0).notNull(),
  offsetY: float("offsetY").default(0).notNull(),
  /**
   * Whether to burn subtitles into the exported MP4. Off produces a clean clip
   * with no text, for cases where captions are added elsewhere or not wanted.
   */
  captionsEnabled: boolean("captionsEnabled").default(true).notNull(),
  /**
   * Optional time-varying framing: [{ start, end, zoom, offsetX, offsetY }] in
   * clip-relative seconds. Lets the crop follow different subjects across the
   * clip. When absent, the single zoom/offsetX/offsetY above applies throughout.
   */
  framingSegments: json("framingSegments"),
  /**
   * Background music mixed under this clip: the stored file, where it sits on
   * the timeline, its volume envelope, and how far the original audio ducks.
   * See shared/music.ts for the shape.
   */
  music: json("music"),
  /**
   * How much of the 9:16 frame the video fills. 1 = full (no bars), 0.5 = half
   * height, etc. The remaining space is filled with `barColor`.
   */
  scale: float("scale").default(1).notNull(),
  /**
   * Background colour for the bars when the video is scaled smaller than the
   * frame. CSS hex colour string, e.g. "#000000".
   */
  barColor: varchar("barColor", { length: 9 }).default("#000000").notNull(),
  /**
   * Custom text overlays placed on the clip timeline.
   * Shape: [{ text, start, end, posX, posY, fontSize, color }]
   */
  textOverlays: json("textOverlays"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Clip = typeof clips.$inferSelect;
export type InsertClip = typeof clips.$inferInsert;

export const subtitles = mysqlTable("subtitles", {
  id: int("id").autoincrement().primaryKey(),
  clipId: int("clipId").notNull(),
  userId: int("userId").notNull(),
  words: json("words"),
  style: json("style"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Subtitle = typeof subtitles.$inferSelect;
export type InsertSubtitle = typeof subtitles.$inferInsert;
