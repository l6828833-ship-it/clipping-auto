# Direct publishing

Each Clip Maker user connects their own YouTube channel, Instagram professional account, or TikTok account at `/dashboard/publish`. Finished clips have a **Publish** link in the library and Create results. The user reviews the MP4, caption, visibility, and consent before any upload starts.

The code is implemented; the developer applications and credentials below must be configured before the connection buttons become available. App login through Supabase does not grant permission to upload to social accounts. These are separate connections.

## Rundploy runtime variables

Keep the existing `DATABASE_URL`, `JWT_SECRET`, and `CLIP_MAKER_AUTH_SITE_URL=https://clip-maker.com`. `JWT_SECRET` must be stable and at least 32 characters; changing it makes existing encrypted social tokens unreadable and users must reconnect.

| Variable | Value |
| --- | --- |
| `YOUTUBE_CLIENT_ID` | Google OAuth web client ID for publishing |
| `YOUTUBE_CLIENT_SECRET` | That client's secret |
| `INSTAGRAM_CLIENT_ID` | Instagram App ID from Meta's Instagram business login settings |
| `INSTAGRAM_CLIENT_SECRET` | Its Instagram App Secret |
| `TIKTOK_CLIENT_KEY` | TikTok developer application's client key |
| `TIKTOK_CLIENT_SECRET` | Its client secret |
| `TIKTOK_DIRECT_POST_APPROVED` | Leave unset until TikTok approves public Direct Post access. Set to `1` only after approval. |
| `INSTAGRAM_API_VERSION` | Optional; defaults to `v24.0`. |

Store secrets only in the host's runtime settings. Do not put them in `VITE_` variables or frontend code. Configure whichever platform is ready; others remain disabled.

## Google / YouTube

1. Enable YouTube Data API v3 in the Google Cloud project.
2. Configure a web OAuth client with this exact redirect URI: `https://clip-maker.com/api/social/callback/youtube`.
3. Configure the consent screen, verified domains, privacy policy and terms for Clip Maker. Request `https://www.googleapis.com/auth/youtube.upload` and `https://www.googleapis.com/auth/youtube.readonly`. Read access is used to show the channel identity and check upload processing.
4. Add test users while the OAuth app is in testing. Complete Google's required verification before general customer use.
5. Add the client ID and secret to Rundploy, then deploy. Each user must explicitly connect a Google account with a YouTube channel.

Uploads use the resumable upload protocol. The selected privacy and made-for-kids values are sent explicitly. YouTube determines whether a video qualifies as a Short. Public availability also depends on the platform's processing, permissions and applicable account/project restrictions; do not promise immediate public availability just because the upload returned an ID.

Official references: [OAuth](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps), [resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol), [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert).

## Instagram

1. Create/configure the Instagram product in a Meta developer app using **Instagram API with Instagram Login**.
2. Add `https://clip-maker.com/api/social/callback/instagram` as the OAuth redirect URI.
3. Request `instagram_business_basic` and `instagram_business_content_publish`. Configure developer/test accounts and request the required Advanced Access/App Review for customers outside the app's roles.
4. Add the Instagram App ID and secret to Rundploy.
5. Each user connects an Instagram **Business or Creator** account. Personal accounts are unsupported by this publishing API.

Reels use the already-configured R2 storage. The server gives Instagram a temporary signed URL for the finished file, creates a Reel container, waits for `FINISHED`, and then publishes it. Private Clip Maker media endpoints remain protected. Publishing requires a readable MP4 of 3 seconds to 15 minutes and successful storage in R2. Meta can impose additional codec, size and account limits.

Official references: [Business Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login), [content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing).

## TikTok

1. Register the Clip Maker developer application with **Login Kit** and **Content Posting API → Direct Post**.
2. Register `https://clip-maker.com/api/social/callback/tiktok` as the Login Kit web redirect URI.
3. Request `user.info.basic` and `video.publish`. Add the client key and secret to Rundploy.
4. Use approved test accounts to verify the full flow. Before audit approval, the app restricts posts to `SELF_ONLY`; TikTok also imposes account/user limits.
5. Submit the Direct Post audit. The product must serve creators publishing their own authorized content, rather than copying arbitrary third-party videos. Set `TIKTOK_DIRECT_POST_APPROVED=1` only when approved.

The form loads current creator information, displays the connected nickname, lets the user choose privacy without a default, enforces the account's duration limit, respects disabled interaction settings, and collects content ownership, commercial disclosure and posting consent. Uploads stream in chunks using `FILE_UPLOAD`; tokens and upload URLs are never exposed to the browser. TikTok processing/moderation can take longer than the upload.

Official references: [Direct Post setup](https://developers.tiktok.com/doc/content-posting-api-get-started), [sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines), [creator information](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info), [media transfer](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide).

## Storage, deployment and recovery

The server lazily creates three tables (`accounts`, `oauth_states`, `posts`) in a separate private PostgreSQL schema, `clip_maker_social`. The database role needs permission to create that schema/tables. RLS is enabled without public policies. Do not expose this schema through Supabase's Data API or grant client roles access to it.

Tokens use AES-256-GCM encryption bound to the Clip Maker user and platform. OAuth state is single-use, expires after ten minutes, and must match both the signed-in user and an HttpOnly cookie. Mutating endpoints validate the canonical Origin. One account per platform per Clip Maker user is supported initially.

Publish requests have an idempotency key. Repeating the same request checks the saved result instead of uploading again. A lost response is marked uncertain rather than retried automatically. Users should check their social account before deliberately starting another post after an uncertain outcome.

Processing jobs and platform IDs survive restarts. A server timer and browser status requests check pending posts using atomic database claims. On Cloud Run, use **CPU always allocated** for background processing while the publishing page is closed. With request-only CPU, keep the page open until completion. The request timeout should accommodate uploads (up to ten minutes); clips are capped at 500 MB. The feature does not automatically restart an interrupted upload.

To verify after configuring credentials:

1. Connect an account; check the displayed channel/username, then disconnect and reconnect.
2. Render a short clip. Upload privately to YouTube and TikTok first, using an Instagram test account for Reel publishing.
3. Verify the actual resulting video in the platform. Confirm title/caption, privacy, audio and framing.
4. Test a second Clip Maker user and confirm they cannot see or publish through the first user's accounts.

No real social account was connected and no real post was published during development. Automated tests use provider fixtures:

```sh
node --test tests/social-publishing.test.mjs
npm run build
```
