/**
 * youtube-content-kit — typed client for a YouTube channel's own content:
 * upload videos as private drafts, read channel and video stats (YouTube Data API v3).
 *
 * Sharp edges this client absorbs:
 * - Uploads use the resumable protocol: the session URL comes back in a `Location` header,
 *   chunks must be multiples of 256 KiB, and Google answers each partial chunk with
 *   308 "Resume Incomplete", which fetch would otherwise treat as a redirect
 * - Google returns a refresh token only on the first consent, so sign-in forces `prompt=consent`
 *   and a refresh keeps the stored refresh token
 * - Videos from API projects that have not passed YouTube's compliance audit are locked
 *   as private: the owner cannot publish them until the project is audited
 * - `videos.insert` has its own quota bucket (100 calls a day by default)
 */

import { createHash, randomBytes } from "node:crypto";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHUNK = 32 * 256 * 1024;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export interface YouTubeContentConfig {
  /** User access token from `exchangeCode` / `refreshAccessToken`. */
  accessToken: string;
  /** Overrides for testing. */
  apiBase?: string;
  uploadBase?: string;
  /** Custom fetch (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface TokenSet {
  accessToken: string;
  /** ISO time. Access tokens last an hour. */
  accessExpiresAt: string;
  refreshToken: string;
  scope: string;
}

export type PrivacyStatus = "private" | "unlisted" | "public";

export interface DraftDetails {
  title: string;
  description?: string;
  tags?: string[];
  /** YouTube category id, e.g. "27" Education. Defaults to "22" People & Blogs. */
  categoryId?: string;
  /** Defaults to "private": the owner reviews and publishes it in YouTube Studio. */
  privacyStatus?: PrivacyStatus;
  /** Defaults to false. */
  madeForKids?: boolean;
}

export interface UploadStatus {
  id: string;
  title?: string;
  /** "uploaded" while YouTube processes it, then "processed"; or "failed", "rejected", "deleted". */
  uploadStatus?: string;
  privacyStatus?: PrivacyStatus;
  failureReason?: string;
  rejectionReason?: string;
  /** "processing", "succeeded", "failed" or "terminated". Only visible to the owner. */
  processingStatus?: string;
  studioUrl: string;
}

export interface ChannelStats {
  id: string;
  title?: string;
  customUrl?: string;
  subscriberCount?: number;
  viewCount?: number;
  videoCount?: number;
}

export interface Video {
  id: string;
  title?: string;
  publishedAt?: string;
  privacyStatus?: PrivacyStatus;
  /** ISO 8601 duration, e.g. "PT42S". */
  duration?: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  url: string;
}

export class YouTubeContentError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(`YouTube API error ${status} ${reason}: ${message}`);
    this.name = "YouTubeContentError";
  }
}

// ---------- pure helpers ----------

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkcePair(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: (opts.scopes ?? DEFAULT_SCOPES).join(" "),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  })}`;
}

/** Reads the code from the URL Google redirected to, after checking it belongs to this login. */
export function codeFromCallback(callbackUrl: string, expectedState: string): string {
  const params = new URL(callbackUrl.trim(), "http://127.0.0.1").searchParams;
  if (params.get("state") !== expectedState) {
    throw new Error("The callback's state belongs to another login attempt. Start the login again.");
  }
  const error = params.get("error");
  if (error) throw new Error(`Google refused the login: ${error}`);
  const code = params.get("code");
  if (!code) throw new Error("The callback has no code.");
  return code;
}

export function needsRefresh(token: Pick<TokenSet, "accessExpiresAt">, now = Date.now()): boolean {
  return Date.parse(token.accessExpiresAt) - now < REFRESH_MARGIN_MS;
}

/** The byte after the last one Google holds, from a 308 response's `Range: bytes=0-N` header. */
export function nextOffset(range: string | null): number {
  const match = range?.match(/bytes=0-(\d+)/);
  return match ? Number(match[1]) + 1 : 0;
}

export const studioUrl = (videoId: string) => `https://studio.youtube.com/video/${videoId}/edit`;

// ---------- OAuth ----------

interface OAuthOptions {
  clientId: string;
  clientSecret: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
}

export async function exchangeCode(
  opts: OAuthOptions & { code: string; redirectUri: string; codeVerifier: string },
): Promise<TokenSet> {
  const json = await requestToken(opts, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  if (typeof json.refresh_token !== "string") {
    throw new YouTubeContentError(400, "no_refresh_token", "Google sent no refresh token. Sign in again.");
  }
  return toTokenSet(json, json.refresh_token);
}

export async function refreshAccessToken(opts: OAuthOptions & { refreshToken: string }): Promise<TokenSet> {
  const json = await requestToken(opts, { grant_type: "refresh_token", refresh_token: opts.refreshToken });
  return toTokenSet(json, typeof json.refresh_token === "string" ? json.refresh_token : opts.refreshToken);
}

async function requestToken(opts: OAuthOptions, body: Record<string, string>): Promise<Record<string, unknown>> {
  const f = opts.fetch ?? fetch;
  const res = await f(opts.tokenUrl ?? TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: opts.clientId, client_secret: opts.clientSecret, ...body }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string") {
    throw new YouTubeContentError(
      res.status,
      String(json.error ?? "token_error"),
      String(json.error_description ?? "token request failed"),
    );
  }
  return json;
}

function toTokenSet(json: Record<string, unknown>, refreshToken: string): TokenSet {
  return {
    accessToken: String(json.access_token),
    accessExpiresAt: new Date(Date.now() + Number(json.expires_in) * 1000).toISOString(),
    refreshToken,
    scope: String(json.scope),
  };
}

// ---------- client ----------

interface GoogleError {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> };
}

async function failure(res: Response): Promise<YouTubeContentError> {
  const body = (await res.json().catch(() => ({}))) as GoogleError;
  return new YouTubeContentError(
    res.status,
    body.error?.errors?.[0]?.reason ?? "unknown",
    body.error?.message ?? res.statusText,
  );
}

const count = (value: unknown) => (value === undefined ? undefined : Number(value));

interface VideoResource {
  id: string;
  snippet?: { title?: string; publishedAt?: string };
  status?: { uploadStatus?: string; privacyStatus?: PrivacyStatus; failureReason?: string; rejectionReason?: string };
  processingDetails?: { processingStatus?: string };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

export function createYouTubeContent(config: YouTubeContentConfig) {
  const api = config.apiBase ?? API_BASE;
  const uploads = config.uploadBase ?? UPLOAD_BASE;
  const f = config.fetch ?? fetch;
  const auth = { Authorization: `Bearer ${config.accessToken}` };

  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const res = await f(`${api}${path}?${new URLSearchParams(params)}`, { headers: auth });
    if (!res.ok) throw await failure(res);
    return (await res.json()) as T;
  }

  async function videos(ids: string[], part: string): Promise<VideoResource[]> {
    if (ids.length === 0) return [];
    const data = await get<{ items?: VideoResource[] }>("/videos", { part, id: ids.join(",") });
    return data.items ?? [];
  }

  async function getUploadStatus(videoId: string): Promise<UploadStatus> {
    const [v] = await videos([videoId], "snippet,status,processingDetails");
    if (!v) throw new YouTubeContentError(404, "videoNotFound", `No video ${videoId} on this channel`);
    return {
      id: v.id,
      title: v.snippet?.title,
      uploadStatus: v.status?.uploadStatus,
      privacyStatus: v.status?.privacyStatus,
      failureReason: v.status?.failureReason,
      rejectionReason: v.status?.rejectionReason,
      processingStatus: v.processingDetails?.processingStatus,
      studioUrl: studioUrl(v.id),
    };
  }

  async function getChannel(): Promise<ChannelStats & { uploadsPlaylist?: string }> {
    const data = await get<{
      items?: Array<{
        id: string;
        snippet?: { title?: string; customUrl?: string };
        statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string };
        contentDetails?: { relatedPlaylists?: { uploads?: string } };
      }>;
    }>("/channels", { part: "snippet,statistics,contentDetails", mine: "true" });
    const c = data.items?.[0];
    if (!c) throw new YouTubeContentError(404, "channelNotFound", "This Google account has no YouTube channel");
    return {
      id: c.id,
      title: c.snippet?.title,
      customUrl: c.snippet?.customUrl,
      subscriberCount: count(c.statistics?.subscriberCount),
      viewCount: count(c.statistics?.viewCount),
      videoCount: count(c.statistics?.videoCount),
      uploadsPlaylist: c.contentDetails?.relatedPlaylists?.uploads,
    };
  }

  return {
    /** Uploads a video, private by default, so the owner can finish and publish it in YouTube Studio. */
    async uploadDraft(
      video: Uint8Array<ArrayBuffer>,
      details: DraftDetails,
      mimeType = "video/mp4",
    ): Promise<{ videoId: string; studioUrl: string }> {
      if (video.byteLength === 0) throw new RangeError("Video is empty");
      const params = new URLSearchParams({ uploadType: "resumable", part: "snippet,status" });
      const init = await f(`${uploads}/videos?${params}`, {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(video.byteLength),
          "X-Upload-Content-Type": mimeType,
        },
        body: JSON.stringify({
          snippet: {
            title: details.title,
            description: details.description ?? "",
            tags: details.tags ?? [],
            categoryId: details.categoryId ?? "22",
          },
          status: {
            privacyStatus: details.privacyStatus ?? "private",
            selfDeclaredMadeForKids: details.madeForKids ?? false,
          },
        }),
      });
      if (!init.ok) throw await failure(init);
      const session = init.headers.get("location");
      if (!session) throw new YouTubeContentError(init.status, "noUploadUrl", "Google returned no upload session");

      let offset = 0;
      while (true) {
        const end = Math.min(offset + CHUNK, video.byteLength) - 1;
        const res = await f(session, {
          method: "PUT",
          redirect: "manual",
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(end - offset + 1),
            "Content-Range": `bytes ${offset}-${end}/${video.byteLength}`,
          },
          body: video.subarray(offset, end + 1),
        });
        if (res.status === 308) {
          offset = nextOffset(res.headers.get("range"));
          continue;
        }
        if (!res.ok) throw await failure(res);
        const created = (await res.json()) as { id: string };
        return { videoId: created.id, studioUrl: studioUrl(created.id) };
      }
    },

    getUploadStatus,

    /** Polls until YouTube finishes processing the upload, or the attempts run out. */
    async waitForProcessing(
      videoId: string,
      opts: { attempts?: number; intervalMs?: number } = {},
    ): Promise<UploadStatus> {
      const attempts = opts.attempts ?? 30;
      let last = await getUploadStatus(videoId);
      for (let i = 1; i < attempts && last.uploadStatus === "uploaded"; i++) {
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5000));
        last = await getUploadStatus(videoId);
      }
      return last;
    },

    async getChannel(): Promise<ChannelStats> {
      const { uploadsPlaylist: _, ...stats } = await getChannel();
      return stats;
    },

    /** The channel's uploads, newest first, private ones included, with views, likes and comments. */
    async listVideos(limit = 50): Promise<Video[]> {
      const { uploadsPlaylist } = await getChannel();
      if (!uploadsPlaylist) return [];
      const ids: string[] = [];
      let pageToken: string | undefined;
      while (ids.length < limit) {
        const page = await get<{ items?: Array<{ contentDetails: { videoId: string } }>; nextPageToken?: string }>(
          "/playlistItems",
          {
            part: "contentDetails",
            playlistId: uploadsPlaylist,
            maxResults: String(Math.min(50, limit - ids.length)),
            ...(pageToken ? { pageToken } : {}),
          },
        );
        ids.push(...(page.items ?? []).map((i) => i.contentDetails.videoId));
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      const out: Video[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        for (const v of await videos(ids.slice(i, i + 50), "snippet,status,contentDetails,statistics")) {
          out.push({
            id: v.id,
            title: v.snippet?.title,
            publishedAt: v.snippet?.publishedAt,
            privacyStatus: v.status?.privacyStatus,
            duration: v.contentDetails?.duration,
            viewCount: count(v.statistics?.viewCount),
            likeCount: count(v.statistics?.likeCount),
            commentCount: count(v.statistics?.commentCount),
            url: `https://youtu.be/${v.id}`,
          });
        }
      }
      return out;
    },
  };
}

export type YouTubeContent = ReturnType<typeof createYouTubeContent>;
