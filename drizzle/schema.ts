import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const sourceType = pgEnum("source_type", ["upload", "url"]);
export const videoStatus = pgEnum("video_status", ["pending", "transcribing", "analyzing", "done", "error"]);
export const hostedStatus = pgEnum("hosted_status", ["none", "downloading", "ready", "error"]);
export const clipStatus = pgEnum("clip_status", ["pending", "rendering", "done", "error"]);

const createdAt = () => timestamp("createdAt", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull();

/** Core user table backing the email/password authentication flow. */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  passwordHash: varchar("passwordHash", { length: 255 }),
  role: userRole("role").default("user").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastSignedIn: timestamp("lastSignedIn", { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const videos = pgTable("videos", {
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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Video = typeof videos.$inferSelect;
export type InsertVideo = typeof videos.$inferInsert;

export const clips = pgTable("clips", {
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
  music: jsonb("music"),
  scale: real("scale").default(1).notNull(),
  barColor: varchar("barColor", { length: 9 }).default("#000000").notNull(),
  textOverlays: jsonb("textOverlays"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Clip = typeof clips.$inferSelect;
export type InsertClip = typeof clips.$inferInsert;

export const subtitles = pgTable("subtitles", {
  id: serial("id").primaryKey(),
  clipId: integer("clipId").notNull(),
  userId: integer("userId").notNull(),
  words: jsonb("words"),
  style: jsonb("style"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Subtitle = typeof subtitles.$inferSelect;
export type InsertSubtitle = typeof subtitles.$inferInsert;
