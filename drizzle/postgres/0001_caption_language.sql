ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "captionLanguage" varchar(8) DEFAULT 'auto' NOT NULL;
