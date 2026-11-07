// Supabase Edge Function: post-video
// Gives the phone page a one-time upload link for the social-videos bucket,
// then publishes the uploaded video to TikTok + YouTube Shorts through Buffer.
// Videos older than 2 days are deleted on every call, so the bucket never fills up.
//
// Secrets (Edge Functions > Secrets):
//   POST_PASSCODE   - the passcode typed on the phone page
//   BUFFER_API_KEY  - from https://publish.buffer.com/settings/api
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// JWT verification stays ON: the page sends the public anon key; the passcode is checked here.

import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "social-videos";
const KEEP_HOURS = 48;
const TIKTOK_CHANNEL = "6aef2478e29c69a171937a10";
const YOUTUBE_CHANNEL = "6aef251de29c69a17193820d";
const YOUTUBE_CATEGORY = "26"; // Howto & Style
const ALLOWED_EXT = ["mp4", "mov"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return keys.default || Object.values(keys)[0] || "";
  } catch {
    return "";
  }
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey() as string);

async function cleanup() {
  const { data, error } = await supabase.storage.from(BUCKET).list("", {
    limit: 1000,
    sortBy: { column: "created_at", order: "asc" },
  });
  if (error || !data) return { deleted: 0, error: error?.message };
  const cutoff = Date.now() - KEEP_HOURS * 3600 * 1000;
  const old = data
    .filter((f) => f.id && f.created_at && new Date(f.created_at).getTime() < cutoff)
    .map((f) => f.name);
  if (old.length) await supabase.storage.from(BUCKET).remove(old);
  return { deleted: old.length };
}

const CREATE_POST = `
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id status } }
    ... on MutationError { message }
  }
}`;

async function bufferPost(input: Record<string, unknown>) {
  const res = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("BUFFER_API_KEY")}`,
    },
    body: JSON.stringify({ query: CREATE_POST, variables: { input } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    const msg = body.errors?.map((e: { message: string }) => e.message).join("; ") ||
      `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  const r = body.data?.createPost;
  if (r?.post) return { ok: true, postId: r.post.id, status: r.post.status };
  return { ok: false, error: r?.message || "Unknown Buffer response" };
}

function youtubeTitle(caption: string, title?: string) {
  const t = (title || "").trim() ||
    caption.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ||
    "New art reveal";
  return t.replace(/#\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "New art reveal";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  const passcode = Deno.env.get("POST_PASSCODE") || "";
  if (!passcode || !sameString(String(body.passcode || ""), passcode)) {
    await new Promise((r) => setTimeout(r, 1500));
    return json({ error: "wrong_passcode" }, 401);
  }

  if (body.action === "check") return json({ ok: true });

  if (body.action === "sign") {
    const ext = String(body.ext || "mp4").toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return json({ error: "Only mp4 or mov videos" }, 400);
    const cleaned = await cleanup();
    const path = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ path, signedUrl: data.signedUrl, cleaned });
  }

  if (body.action === "publish") {
    const path = String(body.path || "");
    const caption = String(body.caption || "").trim();
    if (!path || !caption) return json({ error: "Missing video or caption" }, 400);
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const videoUrl = pub.publicUrl;
    const asset = [{ video: { url: videoUrl } }];

    const [tiktok, youtube] = await Promise.all([
      bufferPost({
        channelId: TIKTOK_CHANNEL,
        text: caption,
        schedulingType: "automatic",
        mode: "shareNow",
        needsApproval: false,
        assets: asset,
      }),
      bufferPost({
        channelId: YOUTUBE_CHANNEL,
        text: caption,
        schedulingType: "automatic",
        mode: "shareNow",
        needsApproval: false,
        assets: asset,
        metadata: {
          youtube: {
            title: youtubeTitle(caption, body.title),
            categoryId: YOUTUBE_CATEGORY,
            madeForKids: false,
            privacy: "public",
          },
        },
      }),
    ]);
    return json({ videoUrl, tiktok, youtube });
  }

  return json({ error: "Unknown action" }, 400);
});
