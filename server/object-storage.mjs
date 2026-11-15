/**
 * Media files in an S3-compatible bucket (Cloudflare R2, AWS S3, Supabase,
 * MinIO...), so they outlive the instance that made them.
 *
 * On Rundploy the app runs on Cloud Run, where the disk lives in the
 * instance's memory: a restart loses every imported video and rendered clip,
 * a second instance never had them, and one response may not exceed 32 MiB,
 * so a long clip could not even be sent whole. With a bucket configured, each
 * clip and import is copied there once it is written. The browser plays and
 * downloads it straight from the bucket through a short-lived signed link, and
 * an instance that needs the file for work fetches it back to its own disk.
 *
 * Off unless all of these are set:
 *   CLIP_MAKER_S3_ENDPOINT            e.g. https://<account id>.r2.cloudflarestorage.com
 *   CLIP_MAKER_S3_BUCKET              e.g. clip-maker
 *   CLIP_MAKER_S3_ACCESS_KEY_ID
 *   CLIP_MAKER_S3_SECRET_ACCESS_KEY
 *   CLIP_MAKER_S3_REGION              optional, "auto" for R2
 */
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function settings() {
  const read = (name) => process.env[name]?.trim() || "";
  return {
    endpoint: read("CLIP_MAKER_S3_ENDPOINT"),
    bucket: read("CLIP_MAKER_S3_BUCKET"),
    accessKeyId: read("CLIP_MAKER_S3_ACCESS_KEY_ID"),
    secretAccessKey: read("CLIP_MAKER_S3_SECRET_ACCESS_KEY"),
    region: read("CLIP_MAKER_S3_REGION") || "auto",
  };
}

export function storageEnabled() {
  const s = settings();
  return Boolean(s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey);
}

let client = null;
function bucketClient() {
  if (!client) {
    const s = settings();
    client = new S3Client({
      region: s.region,
      endpoint: s.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
      /* R2 and most S3 look-alikes reject the newer checksum headers the SDK
       * adds by default, so only send them when an operation needs them. */
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

/** "clip" + "clip-1-abc.mp4" → "clips/clip-1-abc.mp4". File names are content hashes, so a key never changes meaning. */
const keyFor = (kind, name) => `${kind}s/${name}`;

/* What each instance has learnt about the bucket. A file that is there stays
 * there until deleted here; "not there" is only trusted briefly, since another
 * instance may be uploading it. */
const known = new Map();
const MISSING_FOR_MS = 15_000;

/** The stored object's size and metadata, or null when it is not in the bucket. */
export async function storedInfo(kind, name) {
  if (!storageEnabled()) return null;
  const key = keyFor(kind, name);
  const cached = known.get(key);
  if (cached && (cached.info || Date.now() - cached.at < MISSING_FOR_MS)) return cached.info;
  let info = null;
  try {
    const head = await bucketClient().send(new HeadObjectCommand({ Bucket: settings().bucket, Key: key }));
    info = { size: Number(head.ContentLength) || 0, metadata: head.Metadata ?? {} };
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status !== 404 && error?.name !== "NotFound") {
      console.warn(`[Storage] Could not check ${key}: ${String(error?.message ?? error).slice(0, 200)}`);
      return null;
    }
  }
  if (known.size >= 5000) known.delete(known.keys().next().value);
  known.set(key, { info, at: Date.now() });
  return info;
}

/**
 * Copies a finished file into the bucket. `metadata` (short strings) is kept
 * with it, such as a video's length, so other instances can describe it
 * without fetching it. Resolves to true once stored; failures are logged and
 * resolve to false, because the local file still works on this instance.
 */
const storing = new Map();
export function storeFile(kind, name, filePath, metadata = {}) {
  if (!storageEnabled()) return Promise.resolve(false);
  const key = keyFor(kind, name);
  /* Asked again while the copy is still going up: wait for that one. */
  const running = storing.get(key);
  if (running) return running;
  const job = putFile(key, filePath, metadata, name).finally(() => storing.delete(key));
  storing.set(key, job);
  return job;
}

async function putFile(key, filePath, metadata, name) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { size } = await stat(filePath);
      await bucketClient().send(new PutObjectCommand({
        Bucket: settings().bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: "video/mp4",
        /* Opening the link saves the file. Kept on the object because R2 does
         * not take the response-content-disposition override on a download
         * link. A video element plays it regardless. */
        ContentDisposition: `attachment; filename="${name}"`,
        Metadata: Object.fromEntries(Object.entries(metadata)
          .filter(([, value]) => value != null && value !== "")
          .map(([k, value]) => [k, String(value).slice(0, 200)])),
      }));
      known.set(key, { info: { size, metadata }, at: Date.now() });
      return true;
    } catch (error) {
      if (attempt === 2) {
        console.warn(`[Storage] Could not store ${key}: ${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
  }
  return false;
}

/**
 * A signed link the browser can fetch the file from directly, valid for six
 * hours: long enough for an editing session, short enough not to be a
 * permanent public address. A video element plays it; opening it saves the
 * file (the object is stored as an attachment, see storeFile).
 */
export async function signedLink(kind, name) {
  return getSignedUrl(bucketClient(), new GetObjectCommand({
    Bucket: settings().bucket,
    Key: keyFor(kind, name),
  }), { expiresIn: 6 * 3600 });
}

const fetching = new Map();
/**
 * Brings a stored file back to `filePath` on this instance's disk, for work
 * that needs it locally (rendering, framing, transcribing). Resolves to true
 * when the file is there afterwards. Two requests for one file share a fetch.
 */
export function fetchToFile(kind, name, filePath) {
  if (!storageEnabled()) return Promise.resolve(false);
  const key = keyFor(kind, name);
  const running = fetching.get(key);
  if (running) return running;
  const job = (async () => {
    if (!(await storedInfo(kind, name))) return false;
    const partial = `${filePath}.fetch`;
    try {
      const object = await bucketClient().send(new GetObjectCommand({ Bucket: settings().bucket, Key: key }));
      await pipeline(object.Body, createWriteStream(partial));
      await rename(partial, filePath);
      console.log(`[Storage] Fetched ${key} back to this instance.`);
      return true;
    } catch (error) {
      console.warn(`[Storage] Could not fetch ${key}: ${String(error?.message ?? error).slice(0, 200)}`);
      await rm(partial, { force: true }).catch(() => {});
      return false;
    }
  })().finally(() => fetching.delete(key));
  fetching.set(key, job);
  return job;
}

export async function removeStored(kind, name) {
  if (!storageEnabled()) return;
  const key = keyFor(kind, name);
  known.delete(key);
  await bucketClient().send(new DeleteObjectCommand({ Bucket: settings().bucket, Key: key }))
    .catch((error) => console.warn(`[Storage] Could not delete ${key}: ${String(error?.message ?? error).slice(0, 200)}`));
}
