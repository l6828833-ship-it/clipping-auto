CREATE TABLE `clips` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` int NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(512),
	`startTime` float,
	`endTime` float,
	`engagementScore` float,
	`status` enum('pending','rendering','done','error') NOT NULL DEFAULT 'pending',
	`downloadUrl` text,
	`thumbnailUrl` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `clips_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `subtitles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`clipId` int NOT NULL,
	`userId` int NOT NULL,
	`words` json,
	`style` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `subtitles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(512),
	`sourceType` enum('upload','url') NOT NULL,
	`sourceUrl` text,
	`status` enum('pending','transcribing','analyzing','done','error') NOT NULL DEFAULT 'pending',
	`duration` float,
	`transcript` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `videos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `passwordHash` varchar(255);