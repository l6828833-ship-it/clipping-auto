import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import pg from "pg";

export function tokenVault(secret) {
  if (!secret || secret.length < 32) throw new Error("A stable JWT_SECRET of at least 32 characters is required for publishing.");
  const key = Buffer.from(hkdfSync("sha256", secret, "clip-maker", "social-tokens-v1", 32));
  return {
    seal(value, owner) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(owner));
      const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map(v => v.toString("base64url")).join(".");
    },
    open(value, owner) {
      const [iv, tag, data] = value.split(".").map(v => Buffer.from(v, "base64url"));
      const cipher = createDecipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(owner));
      cipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
    },
  };
}

// Separate from application tables so installations using either public or
// clip_maker retain the same connections. Never exposed through Supabase's API.
export function createSocialStore(env = process.env, databasePool) {
  const pool = databasePool || new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10_000 });
  let ready;
  async function init() {
    if (!env.DATABASE_URL) throw new Error("Publishing storage is not configured.");
    if (!ready) ready = pool.query(`
      CREATE SCHEMA IF NOT EXISTS clip_maker_social;
      REVOKE ALL ON SCHEMA clip_maker_social FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS clip_maker_social.accounts (
        user_id integer NOT NULL, platform text NOT NULL, external_id text NOT NULL,
        label text NOT NULL, tokens text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, platform)
      );
      CREATE TABLE IF NOT EXISTS clip_maker_social.oauth_states (
        id text PRIMARY KEY, user_id integer NOT NULL, platform text NOT NULL,
        verifier text NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clip_maker_social.posts (
        id uuid PRIMARY KEY, user_id integer NOT NULL, platform text NOT NULL,
        clip_id integer NOT NULL, account_id text NOT NULL, request_hash text NOT NULL,
        status text NOT NULL DEFAULT 'uploading', remote jsonb, url text, error text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS social_posts_owner ON clip_maker_social.posts (user_id, created_at DESC);
      REVOKE ALL ON ALL TABLES IN SCHEMA clip_maker_social FROM PUBLIC;
      ALTER TABLE clip_maker_social.accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE clip_maker_social.oauth_states ENABLE ROW LEVEL SECURITY;
      ALTER TABLE clip_maker_social.posts ENABLE ROW LEVEL SECURITY;
    `).catch(error => { ready = undefined; throw error; });
    await ready;
  }
  async function query(sql, values = []) { await init(); return pool.query(sql, values); }
  return {
    async accounts(user) { return (await query("SELECT platform, external_id, label FROM clip_maker_social.accounts WHERE user_id=$1", [user])).rows; },
    async account(user, platform, client) { return (await (client ? client.query.bind(client) : query)("SELECT * FROM clip_maker_social.accounts WHERE user_id=$1 AND platform=$2", [user, platform])).rows[0]; },
    async saveAccount(user, platform, account, client) {
      await (client ? client.query.bind(client) : query)(`INSERT INTO clip_maker_social.accounts(user_id,platform,external_id,label,tokens) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id,platform) DO UPDATE SET external_id=$3,label=$4,tokens=$5,updated_at=now()`,
      [user, platform, account.external_id, account.label, account.tokens]);
    },
    async disconnect(user, platform) { await query("DELETE FROM clip_maker_social.accounts WHERE user_id=$1 AND platform=$2", [user, platform]); },
    async saveState(id, user, platform, verifier) {
      await query("DELETE FROM clip_maker_social.oauth_states WHERE expires_at < now()");
      await query("INSERT INTO clip_maker_social.oauth_states VALUES($1,$2,$3,$4,now()+interval '10 minutes')", [id,user,platform,verifier]);
    },
    async consumeState(id, user, platform) {
      return (await query("DELETE FROM clip_maker_social.oauth_states WHERE id=$1 AND user_id=$2 AND platform=$3 AND expires_at>now() RETURNING verifier", [id,user,platform])).rows[0];
    },
    async createPost(post) {
      const result = await query(`INSERT INTO clip_maker_social.posts(id,user_id,platform,clip_id,account_id,request_hash)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING *`,
      [post.id,post.user_id,post.platform,post.clip_id,post.account_id,post.request_hash]);
      return result.rows[0];
    },
    async post(id, user) { return (await query("SELECT * FROM clip_maker_social.posts WHERE id=$1 AND user_id=$2", [id,user])).rows[0]; },
    async posts(user) {
      // Never retry an ambiguous upload: the platform may already have it.
      await query(`UPDATE clip_maker_social.posts SET status='unknown',error='The connection was interrupted. Check your social account before posting again.'
        WHERE user_id=$1 AND status IN ('uploading','checking') AND updated_at<now()-interval '15 minutes'`, [user]);
      return (await query("SELECT * FROM clip_maker_social.posts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [user])).rows;
    },
    async updatePost(id, user, state) {
      await query(`UPDATE clip_maker_social.posts SET status=$3,remote=COALESCE($4,remote),url=COALESCE($5,url),error=$6,updated_at=now() WHERE id=$1 AND user_id=$2`,
        [id,user,state.status,state.remote ? JSON.stringify(state.remote) : null,state.url ?? null,state.error ?? null]);
    },
    async claimPost(id, user) {
      return (await query(`UPDATE clip_maker_social.posts SET status='checking',updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status='processing' RETURNING *`, [id,user])).rows[0];
    },
    async pendingPosts() {
      return (await query("SELECT * FROM clip_maker_social.posts WHERE status='processing' ORDER BY updated_at LIMIT 10")).rows;
    },
    // Serialise token refresh with a cross-instance database advisory lock.
    async withAccountLock(user, platform, fn) {
      await init();
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock($1,hashtext($2))", [user, `social:${platform}`]);
        return await fn(client);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1,hashtext($2))", [user, `social:${platform}`]).catch(() => {});
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
