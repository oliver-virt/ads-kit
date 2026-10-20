/**
 * tiktok-content-kit — typed client for a TikTok account's own content:
 * upload drafts (Content Posting API), read account and video stats (Display API).
 *
 * Sharp edges this client absorbs:
 * - Errors arrive in the body (`error.code !== "ok"`), often with HTTP 200
 * - The OAuth token endpoint uses a different error shape (`error`, `error_description`)
 * - Uploads must be chunked by TikTok's rules (5-64 MB chunks, the last up to 128 MB,
 *   files up to 64 MB in one chunk), sent in order with exact Content-Range headers
 * - The OAuth `code` in the redirect is URL-encoded and must be decoded once
 * - Unaudited apps can only upload drafts (`video.upload`) or post privately
 */

const DEFAULT_BASE = "https://open.tiktokapis.com/v2";
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const MB = 1024 * 1024;
const SINGLE_CHUNK_MAX = 64 * MB;
const SPLIT_CHUNK = 10 * MB;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const DEFAULT_SCOPES = ["user.info.basic", "user.info.stats", "video.list", "video.upload"];

export interface TikTokContentConfig {
  /** User access token from `exchangeCode` / `refreshAccessToken`. */
  accessToken: string;
  /** Override for testing. */
  baseUrl?: string;
  /** Custom fetch (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface TokenSet {
  accessToken: string;
  /** ISO time. Access tokens last 24 hours. */
  accessExpiresAt: string;
  refreshToken: string;
  /** ISO time. Refresh tokens last a year. */
  refreshExpiresAt: string;
  openId: string;
  scope: string;
}

export type PublishStatusName =
  | "PROCESSING_UPLOAD"
  | "PROCESSING_DOWNLOAD"
  | "SEND_TO_USER_INBOX"
  | "PUBLISH_COMPLETE"
  | "FAILED";

export interface PublishStatus {
  status: PublishStatusName;
  fail_reason?: string;
  publicaly_available_post_id?: string[];
  uploaded_bytes?: number;
}

export interface UserStats {
  open_id?: string;
  display_name?: string;
  avatar_url?: string;
  follower_count?: number;
  following_count?: number;
  likes_count?: number;
  video_count?: number;
}

export interface Video {
  id: string;
  title?: string;
  video_description?: string;
  create_time: number;
  duration?: number;
  cover_image_url?: string;
  share_url?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
}

export interface VideoPage {
  videos: Video[];
  cursor: number;
  hasMore: boolean;
}

export class TikTokContentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly logId?: string,
  ) {
    super(`TikTok API error ${code}: ${message}${logId ? ` (log ${logId})` : ""}`);
    this.name = "TikTokContentError";
  }
}

// ---------- pure helpers ----------

export interface ChunkPlan {
  chunkSize: number;
  count: number;
  ranges: Array<[number, number]>;
}

export function chunkPlan(size: number): ChunkPlan {
  if (size <= 0) throw new RangeError("Video is empty");
  if (size <= SINGLE_CHUNK_MAX) return { chunkSize: size, count: 1, ranges: [[0, size - 1]] };
  const count = Math.floor(size / SPLIT_CHUNK);
  const ranges = Array.from({ length: count }, (_, i): [number, number] => [
    i * SPLIT_CHUNK,
    i === count - 1 ? size - 1 : (i + 1) * SPLIT_CHUNK - 1,
  ]);
  return { chunkSize: SPLIT_CHUNK, count, ranges };
}

export function authorizeUrl(opts: {
  clientKey: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    client_key: opts.clientKey,
    scope: (opts.scopes ?? DEFAULT_SCOPES).join(","),
    response_type: "code",
    redirect_uri: opts.redirectUri,
    state: opts.state,
  })}`;
}

/** Reads the code from the URL TikTok redirected to, after checking it belongs to this login. */
export function codeFromCallback(callbackUrl: string, expectedState: string): string {
  const params = new URL(callbackUrl.trim()).searchParams;
  if (params.get("state") !== expectedState) {
    throw new Error("The callback URL's state belongs to another login attempt. Start the login again.");
  }
  const error = params.get("error");
  if (error) {
    throw new Error(`TikTok refused the login: ${error} ${params.get("error_description") ?? ""}`.trim());
  }
  const code = params.get("code");
  if (!code) throw new Error("The callback URL has no code.");
  return code;
}

export function needsRefresh(token: Pick<TokenSet, "accessExpiresAt">, now = Date.now()): boolean {
  return Date.parse(token.accessExpiresAt) - now < REFRESH_MARGIN_MS;
}

// ---------- OAuth ----------

interface OAuthOptions {
  clientKey: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function exchangeCode(
  opts: OAuthOptions & { code: string; redirectUri: string },
): Promise<TokenSet> {
  return requestToken(opts, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
}

export function refreshAccessToken(opts: OAuthOptions & { refreshToken: string }): Promise<TokenSet> {
  return requestToken(opts, { grant_type: "refresh_token", refresh_token: opts.refreshToken });
}

async function requestToken(opts: OAuthOptions, body: Record<string, string>): Promise<TokenSet> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${opts.baseUrl ?? DEFAULT_BASE}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ client_key: opts.clientKey, client_secret: opts.clientSecret, ...body }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string") {
    throw new TikTokContentError(
      String(json.error ?? res.status),
      String(json.error_description ?? "token request failed"),
      typeof json.log_id === "string" ? json.log_id : undefined,
    );
  }
  const now = Date.now();
  return {
    accessToken: json.access_token,
    accessExpiresAt: new Date(now + Number(json.expires_in) * 1000).toISOString(),
    refreshToken: String(json.refresh_token),
    refreshExpiresAt: new Date(now + Number(json.refresh_expires_in) * 1000).toISOString(),
    openId: String(json.open_id),
    scope: String(json.scope),
  };
}

// ---------- client ----------

interface Envelope<T> {
  data: T;
  error: { code: string; message: string; log_id?: string };
}

const USER_FIELDS = "open_id,display_name,avatar_url,follower_count,following_count,likes_count,video_count";
const VIDEO_FIELDS =
  "id,title,video_description,create_time,duration,cover_image_url,share_url,view_count,like_count,comment_count,share_count";

export function createTikTokContent(config: TikTokContentConfig) {
  const base = config.baseUrl ?? DEFAULT_BASE;
  const f = config.fetch ?? fetch;
  const auth = { Authorization: `Bearer ${config.accessToken}` };

  async function call<T>(path: string, init: RequestInit): Promise<T> {
    const res = await f(`${base}${path}`, init);
    const body = (await res.json()) as Envelope<T>;
    if (!body.error || body.error.code !== "ok") {
      throw new TikTokContentError(
        body.error?.code ?? String(res.status),
        body.error?.message ?? "no error body",
        body.error?.log_id,
      );
    }
    return body.data;
  }

  const post = <T>(path: string, payload: unknown) =>
    call<T>(path, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(payload),
    });

  async function getPublishStatus(publishId: string): Promise<PublishStatus> {
    return post<PublishStatus>("/post/publish/status/fetch/", { publish_id: publishId });
  }

  async function listVideos(opts: { cursor?: number; maxCount?: number } = {}): Promise<VideoPage> {
    const data = await post<{ videos?: Video[]; cursor?: number; has_more?: boolean }>(
      `/video/list/?fields=${VIDEO_FIELDS}`,
      { max_count: opts.maxCount ?? 20, ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }) },
    );
    return { videos: data.videos ?? [], cursor: data.cursor ?? 0, hasMore: data.has_more ?? false };
  }

  return {
    /** Uploads a video as a draft to the account's TikTok inbox; the creator finishes and posts it in the app. */
    async uploadDraft(video: Uint8Array<ArrayBuffer>, mimeType = "video/mp4"): Promise<{ publishId: string }> {
      const plan = chunkPlan(video.byteLength);
      const init = await post<{ publish_id: string; upload_url: string }>(
        "/post/publish/inbox/video/init/",
        {
          source_info: {
            source: "FILE_UPLOAD",
            video_size: video.byteLength,
            chunk_size: plan.chunkSize,
            total_chunk_count: plan.count,
          },
        },
      );
      for (const [i, [from, to]] of plan.ranges.entries()) {
        const res = await f(init.upload_url, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(to - from + 1),
            "Content-Range": `bytes ${from}-${to}/${video.byteLength}`,
          },
          body: video.subarray(from, to + 1),
        });
        if (res.status !== 201 && res.status !== 206) {
          throw new TikTokContentError(String(res.status), `chunk ${i + 1}/${plan.count} upload failed`);
        }
      }
      return { publishId: init.publish_id };
    },

    getPublishStatus,

    /** Polls until the draft reaches the inbox (or is posted), fails, or the attempts run out. */
    async waitForPublish(
      publishId: string,
      opts: { attempts?: number; intervalMs?: number } = {},
    ): Promise<PublishStatus> {
      const attempts = opts.attempts ?? 30;
      let last = await getPublishStatus(publishId);
      for (let i = 1; i < attempts && last.status.startsWith("PROCESSING"); i++) {
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? 4000));
        last = await getPublishStatus(publishId);
      }
      return last;
    },

    async getUser(): Promise<UserStats> {
      const data = await call<{ user: UserStats }>(`/user/info/?fields=${USER_FIELDS}`, { headers: auth });
      return data.user;
    },

    listVideos,

    /** Newest first, following the cursor until `limit` videos or the end. */
    async listAllVideos(limit = 200): Promise<Video[]> {
      const videos: Video[] = [];
      let cursor: number | undefined;
      while (videos.length < limit) {
        const page = await listVideos({ cursor, maxCount: Math.min(20, limit - videos.length) });
        videos.push(...page.videos);
        if (!page.hasMore || page.videos.length === 0) break;
        cursor = page.cursor;
      }
      return videos;
    },
  };
}

export type TikTokContent = ReturnType<typeof createTikTokContent>;
