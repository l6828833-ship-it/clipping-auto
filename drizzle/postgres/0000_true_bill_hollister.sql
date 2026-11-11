CREATE TYPE "public"."clip_status" AS ENUM('pending', 'rendering', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."hosted_status" AS ENUM('none', 'downloading', 'ready', 'error');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('upload', 'url');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."video_status" AS ENUM('pending', 'transcribing', 'analyzing', 'done', 'error');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clips" (
	"id" serial PRIMARY KEY NOT NULL,
	"videoId" integer NOT NULL,
	"userId" integer NOT NULL,
	"title" varchar(512),
	"startTime" real,
	"endTime" real,
	"engagementScore" real,
	"status" "clip_status" DEFAULT 'pending' NOT NULL,
	"downloadUrl" text,
	"thumbnailUrl" text,
	"errorMessage" text,
	"zoom" real DEFAULT 1 NOT NULL,
	"offsetX" real DEFAULT 0 NOT NULL,
	"offsetY" real DEFAULT 0 NOT NULL,
	"captionsEnabled" boolean DEFAULT true NOT NULL,
	"framingSegments" jsonb,
	"music" jsonb,
	"scale" real DEFAULT 1 NOT NULL,
	"barColor" varchar(9) DEFAULT '#000000' NOT NULL,
	"textOverlays" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subtitles" (
	"id" serial PRIMARY KEY NOT NULL,
	"clipId" integer NOT NULL,
	"userId" integer NOT NULL,
	"words" jsonb,
	"style" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"passwordHash" varchar(255),
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "videos" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"title" varchar(512),
	"sourceType" "source_type" NOT NULL,
	"sourceUrl" text,
	"status" "video_status" DEFAULT 'pending' NOT NULL,
	"duration" real,
	"transcript" text,
	"transcriptWords" jsonb,
	"transcriptionEnabled" boolean DEFAULT true NOT NULL,
	"sttCalls" integer DEFAULT 0 NOT NULL,
	"sttSeconds" real DEFAULT 0 NOT NULL,
	"hostedStatus" "hosted_status" DEFAULT 'none' NOT NULL,
	"hostedUrl" text,
	"hostProgress" integer DEFAULT 0 NOT NULL,
	"hostedOffset" real DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"hostError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
