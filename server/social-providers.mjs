import { createReadStream } from "node:fs";

export const PLATFORMS = ["youtube", "instagram", "tiktok"];
export class PublishingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function publishingConfig(env) {
  const site = env.CLIP_MAKER_AUTH_SITE_URL || env.CLIP_MAKER_SITE_URL;
  let origin;
  try {
    const parsed = new URL(site);
    if (parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost")) origin = parsed.origin;
  } catch { /* Connections remain disabled until the canonical site is set. */ }
  const credentials = {
    youtube: [env.YOUTUBE_CLIENT_ID, env.YOUTUBE_CLIENT_SECRET],
    instagram: [env.INSTAGRAM_CLIENT_ID, env.INSTAGRAM_CLIENT_SECRET],
    tiktok: [env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET],
  };
  return { origin, credentials, instagramVersion: env.INSTAGRAM_API_VERSION || "v24.0", tiktokAudited: env.TIKTOK_DIRECT_POST_APPROVED === "1" };
}

export function uploadChunks(size, target = 10 * 1024 * 1024) {
  const chunkSize = Math.min(size, target);
  const count = Math.max(1, Math.floor(size / chunkSize));
  return Array.from({ length: count }, (_, i) => ({ start: i * chunkSize, end: i === count - 1 ? size - 1 : (i + 1) * chunkSize - 1 }));
}

// Never expose provider response bodies, credentials or upload URLs in errors.
export function createSocialProviders(config, fetcher = fetch) {
  async function json(url, options = {}) {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000), ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (data.error && data.error.code !== "ok")) {
      const status = response.status === 401 ? 401 : 502;
      throw new PublishingError(status === 401 ? "Your social connection expired. Reconnect the account." : "The platform rejected this request. Check account permissions and try again.", status);
    }
    return data;
  }
  const bearer = token => ({ Authorization: `Bearer ${token}` });
  const form = (url, body, headers = {}) => json(url, { method: "POST", headers, body: new URLSearchParams(body) });
  const post = (url, token, body = {}) => json(url, { method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const tt = (path, token, body) => post(`https://open.tiktokapis.com/v2/${path}/`, token, body);
  const ig = path => `https://graph.instagram.com/${config.instagramVersion}/${path}`;
  const callback = platform => `${config.origin}/api/social/callback/${platform}`;

  function authorization(platform, state, challenge) {
    const [id] = config.credentials[platform];
    const url = new URL(platform === "youtube" ? "https://accounts.google.com/o/oauth2/v2/auth" : platform === "instagram" ? "https://www.instagram.com/oauth/authorize" : "https://www.tiktok.com/v2/auth/authorize/");
    const common = { response_type: "code", redirect_uri: callback(platform), state };
    const params = platform === "youtube"
      ? { ...common, client_id: id, scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly", access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256" }
      : platform === "instagram"
        ? { ...common, client_id: id, scope: "instagram_business_basic,instagram_business_content_publish", enable_fb_login: "false", force_reauth: "true" }
        : { ...common, client_key: id, scope: "user.info.basic,video.publish" };
    url.search = new URLSearchParams(params).toString();
    return url.href;
  }

  async function exchange(platform, code, verifier) {
    const [clientId, secret] = config.credentials[platform];
    const params = { client_secret: secret, code, grant_type: "authorization_code", redirect_uri: callback(platform) };
    let tokens;
    if (platform === "youtube") tokens = await form("https://oauth2.googleapis.com/token", { ...params, client_id: clientId, code_verifier: verifier });
    else if (platform === "tiktok") tokens = await form("https://open.tiktokapis.com/v2/oauth/token/", { ...params, client_key: clientId });
    else {
      const body = new FormData();
      for (const [key, value] of Object.entries({ ...params, client_id: clientId })) body.set(key, value);
      const response = await json("https://api.instagram.com/oauth/access_token", { method: "POST", body });
      const short = response.data?.[0] || response;
      if (!short.access_token) throw new PublishingError("Instagram did not grant access. Reconnect your professional account.");
      const query = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: secret, access_token: short.access_token });
      tokens = await json(`https://graph.instagram.com/access_token?${query}`);
    }
    if (!tokens.access_token) throw new PublishingError("The platform did not grant publishing access. Reconnect and accept the requested permissions.");
    return { ...tokens, expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
  }

  async function refresh(platform, tokens) {
    const [id, secret] = config.credentials[platform];
    let next;
    if (platform === "instagram") next = await json(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: tokens.access_token })}`);
    else {
      if (!tokens.refresh_token) throw new PublishingError("Reconnect this social account to renew publishing access.", 401);
      next = await form(platform === "youtube" ? "https://oauth2.googleapis.com/token" : "https://open.tiktokapis.com/v2/oauth/token/", {
        [platform === "youtube" ? "client_id" : "client_key"]: id,
        client_secret: secret, grant_type: "refresh_token", refresh_token: tokens.refresh_token,
      });
    }
    if (!next.access_token) throw new PublishingError("Reconnect this social account.", 401);
    return { ...tokens, ...next, expires_at: Date.now() + Number(next.expires_in || 3600) * 1000 };
  }

  async function profile(platform, token) {
    if (platform === "youtube") {
      const data = await json("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: bearer(token) });
      const channel = data.items?.[0];
      if (!channel) throw new PublishingError("Create a YouTube channel on this Google account first.");
      return { external_id: channel.id, label: channel.snippet.title };
    }
    if (platform === "instagram") {
      const data = await json(ig("me?fields=user_id,username"), { headers: bearer(token) });
      if (!data.user_id || !data.username) throw new PublishingError("Connect an Instagram Business or Creator account.");
      return { external_id: String(data.user_id), label: data.username };
    }
    const data = await json("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", { headers: bearer(token) });
    if (!data.data?.user?.open_id) throw new PublishingError("TikTok did not return an account. Try reconnecting.");
    return { external_id: data.data.user.open_id, label: data.data.user.display_name };
  }

  async function creator(platform, token) {
    if (platform !== "tiktok") return null;
    const { data } = await tt("post/publish/creator_info/query", token);
    if (!data || !Array.isArray(data.privacy_level_options)) throw new PublishingError("TikTok publishing is unavailable for this account.");
    return {
      label: data.creator_nickname, username: data.creator_username,
      privacy: data.privacy_level_options.filter(value => config.tiktokAudited || value === "SELF_ONLY"),
      commentDisabled: !!data.comment_disabled, duetDisabled: !!data.duet_disabled, stitchDisabled: !!data.stitch_disabled,
      maxDuration: Number(data.max_video_post_duration_sec),
    };
  }

  async function upload(platform, token, account, media, input) {
    if (platform === "youtube") {
      const init = await fetcher("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { ...bearer(token), "Content-Type": "application/json", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(media.size) },
        body: JSON.stringify({ snippet: { title: input.title, description: input.caption }, status: { privacyStatus: input.privacy, selfDeclaredMadeForKids: input.madeForKids, containsSyntheticMedia: input.aiGenerated } }),
      });
      if (!init.ok) throw new PublishingError("YouTube could not start the upload. Check your channel permissions.", 502);
      const location = new URL(init.headers.get("location"));
      if (location.protocol !== "https:" || location.hostname !== "www.googleapis.com") throw new PublishingError("YouTube returned an unexpected upload address.", 502);
      const stream = createReadStream(media.path);
      try {
        const uploaded = await json(location.href, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(media.size) }, body: stream, duplex: "half", signal: AbortSignal.timeout(10 * 60_000) });
        if (!uploaded.id) throw new PublishingError("YouTube has not confirmed the upload. Check your channel before retrying.", 502);
        return { status: "processing", remote: { id: uploaded.id }, url: `https://www.youtube.com/watch?v=${encodeURIComponent(uploaded.id)}` };
      } finally { stream.destroy(); }
    }
    if (platform === "instagram") {
      if (!media.publicUrl) throw new PublishingError("This clip is not yet available for Instagram. Try rendering it again.");
      const container = await form(ig(`${account.external_id}/media`), { media_type: "REELS", video_url: media.publicUrl, caption: input.caption, share_to_feed: "true" }, bearer(token));
      if (!container.id) throw new PublishingError("Instagram did not accept this clip.", 502);
      return { status: "processing", remote: { container: container.id } };
    }
    const info = await creator(platform, token);
    if (!info.privacy.includes(input.privacy)) throw new PublishingError("Choose one of the privacy options currently allowed by your TikTok account.");
    if (!Number.isFinite(info.maxDuration) || media.duration > info.maxDuration) throw new PublishingError("This clip exceeds your TikTok account’s maximum video length.");
    if (input.brandedContent && input.privacy === "SELF_ONLY") throw new PublishingError("TikTok branded content cannot use Only me visibility.");
    const chunks = uploadChunks(media.size);
    const init = await tt("post/publish/video/init", token, {
      post_info: {
        title: input.caption, privacy_level: input.privacy,
        disable_comment: info.commentDisabled || !input.allowComments,
        disable_duet: info.duetDisabled || !input.allowDuet,
        disable_stitch: info.stitchDisabled || !input.allowStitch,
        brand_content_toggle: input.brandedContent, brand_organic_toggle: input.ownBrand,
        is_aigc: input.aiGenerated,
      },
      source_info: { source: "FILE_UPLOAD", video_size: media.size, chunk_size: chunks[0].end + 1, total_chunk_count: chunks.length },
    });
    const target = new URL(init.data?.upload_url);
    if (target.protocol !== "https:" || !target.hostname.endsWith(".tiktokapis.com")) throw new PublishingError("TikTok returned an unexpected upload address.", 502);
    for (const chunk of chunks) {
      const stream = createReadStream(media.path, chunk);
      try {
        const response = await fetcher(target.href, { method: "PUT", redirect: "error", headers: {
          "Content-Type": "video/mp4", "Content-Length": String(chunk.end - chunk.start + 1),
          "Content-Range": `bytes ${chunk.start}-${chunk.end}/${media.size}`,
        }, body: stream, duplex: "half", signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new PublishingError("TikTok interrupted the upload. Check your account before trying again.", 502);
        await response.body?.cancel();
      } finally { stream.destroy(); }
    }
    return { status: "processing", remote: { id: init.data.publish_id } };
  }

  async function check(platform, token, account, remote) {
    if (platform === "youtube") {
      const data = await json(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(remote.id)}`, { headers: bearer(token) });
      const state = data.items?.[0]?.status;
      if (["failed", "rejected", "deleted"].includes(state?.uploadStatus)) return { status: "failed", error: "YouTube could not process this video. Check YouTube Studio for details." };
      return { status: state?.uploadStatus === "processed" ? "published" : "processing" };
    }
    if (platform === "tiktok") {
      const { data } = await tt("post/publish/status/fetch", token, { publish_id: remote.id });
      if (data.status === "FAILED") return { status: "failed", error: "TikTok rejected this post. Check your account and video requirements." };
      return { status: data.status === "PUBLISH_COMPLETE" ? "published" : "processing" };
    }
    const data = await json(ig(`${remote.container}?fields=status_code`), { headers: bearer(token) });
    if (["ERROR", "EXPIRED"].includes(data.status_code)) return { status: "failed", error: "Instagram could not process this Reel. Check the clip’s format and try again." };
    if (data.status_code !== "FINISHED") return { status: "processing" };
    const published = await form(ig(`${account.external_id}/media_publish`), { creation_id: remote.container }, bearer(token));
    if (!published.id) throw new PublishingError("Instagram has not confirmed publication. Check your profile before trying again.", 502);
    // Publication succeeded even if the optional permalink lookup is unavailable.
    const media = await json(ig(`${published.id}?fields=permalink`), { headers: bearer(token) }).catch(() => ({}));
    const url = typeof media.permalink === "string" && /^https:\/\/(www\.)?instagram\.com\//.test(media.permalink) ? media.permalink : undefined;
    return { status: "published", remote: { ...remote, id: published.id }, url };
  }

  async function revoke(platform, tokens) {
    if (platform === "youtube") await form("https://oauth2.googleapis.com/revoke", { token: tokens.refresh_token || tokens.access_token });
    else if (platform === "tiktok") {
      const [key, secret] = config.credentials[platform];
      await form("https://open.tiktokapis.com/v2/oauth/revoke/", { client_key: key, client_secret: secret, token: tokens.access_token });
    } else await json(ig("me/permissions"), { method: "DELETE", headers: bearer(tokens.access_token) });
  }
  return { authorization, exchange, refresh, profile, creator, upload, check, revoke };
}
