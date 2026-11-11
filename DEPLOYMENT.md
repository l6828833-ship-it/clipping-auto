# Deploy Clip Maker on Rundploy

The project root contains a Dockerfile that builds the Vite website and starts the Express API. The native iOS app can use the same HTTPS origin for YouTube imports.

1. In [Rundploy](https://rundploy.com/dashboard/apps), create a web app. Upload the deployment folder or connect a GitHub branch that contains this build. Use the root `Dockerfile` if the app settings offer Docker builds. The deployment needs a running Node service with FFmpeg and Python.
2. Set the service port to `3000` if prompted. The server also honors a platform-provided `PORT`. If a health check path is available, use `/healthz`.
3. Add the following values as runtime environment secrets.

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | The existing production PostgreSQL connection string. For Supabase on an IPv4-only host, use the Session pooler string from **Connect**. Keep the database tables private to the server. |
   | `JWT_SECRET` | The existing production signing secret to keep sessions valid, or a new value from `openssl rand -hex 32` for a fresh installation. |
   | `INWORLD_API_KEY` | The existing server key for web AI highlights and other Inworld features. |

4. Start with one instance. The web app stores uploaded videos, generated clips, and reels on disk. Mount writable persistent storage at `/app/.data`, or set `CLIP_MAKER_DATA_DIR` to the writable mount path supplied by the host. Confirm that files survive a redeploy before moving real users. When moving an existing site, copy its media volume as well as reusing the database.
5. For a fresh database, run `npm run db:migrate` once with `DATABASE_URL` set before creating web accounts. For an existing deployment, check its Drizzle migration history before running migrations.
6. Open the assigned HTTPS URL and test web sign-in, video import, and clip export. Then set the Xcode target’s `CLIP_MAKER_SERVICE_URL` to that HTTPS origin. The iOS YouTube flow does not require a Clip Maker account.

Rundploy advertises GitHub and folder uploads. Docker builds and persistent volumes need to be confirmed in the app dashboard before publishing the full project.

## Google and Apple sign-in

Add these runtime variables to the web app.

| Name | Value |
| --- | --- |
| `APP_ORIGIN` | The public HTTPS origin of the Clip Maker website, with no path. For local testing use the origin in your browser, such as `http://127.0.0.1:3000`. |
| `SUPABASE_URL` | `https://iqknohhyttgoonlynzcj.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | The project's publishable key from [API Keys](https://supabase.com/dashboard/project/iqknohhyttgoonlynzcj/settings/api-keys). |

Keep `DATABASE_URL` and `JWT_SECRET` configured for Clip Maker's web accounts and sessions. Provider secrets belong in the Supabase provider settings.

1. In [Supabase URL Configuration](https://supabase.com/dashboard/project/iqknohhyttgoonlynzcj/auth/url-configuration), set **Site URL** to `APP_ORIGIN` and add the exact redirect URL `<APP_ORIGIN>/api/auth/supabase/callback`.
2. In [Google Auth Platform](https://console.cloud.google.com/auth/clients), create a Web application OAuth client. Add the Clip Maker website to its authorized JavaScript origins and `https://iqknohhyttgoonlynzcj.supabase.co/auth/v1/callback` to its authorized redirect URIs. Enter the client ID and secret in [Supabase Google provider settings](https://supabase.com/dashboard/project/iqknohhyttgoonlynzcj/auth/providers?provider=Google). [Google setup guide](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)
3. In Apple Developer, associate a Services ID with a primary App ID that has Sign in with Apple enabled. Configure the Supabase project hostname as the domain and `https://iqknohhyttgoonlynzcj.supabase.co/auth/v1/callback` as the return URL. Enter the Services ID and signed client secret in [Supabase Apple provider settings](https://supabase.com/dashboard/project/iqknohhyttgoonlynzcj/auth/providers?provider=Apple). Renew the Apple client secret before it expires. [Apple setup guide](https://supabase.com/docs/guides/auth/social-sign-in/auth-apple)

Clip Maker identifies social accounts by their Supabase user ID. If a user already has an email/password workspace, they can keep using that sign-in method to access it. The first social sign-in creates a workspace for the Supabase account.
