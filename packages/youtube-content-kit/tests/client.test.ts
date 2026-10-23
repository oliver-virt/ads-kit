import { describe, expect, it, vi } from "vitest";
import {
  authorizeUrl,
  codeFromCallback,
  createYouTubeContent,
  exchangeCode,
  needsRefresh,
  nextOffset,
  pkcePair,
  refreshAccessToken,
} from "../src/index.js";
import { parseEnv } from "../src/store.js";

const MB = 1024 * 1024;

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mockFetch(responses: Reply[]) {
  let i = 0;
  return vi.fn().mockImplementation(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    const status = r.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: "",
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body,
    };
  });
}

describe("OAuth helpers", () => {
  it("asks for offline access with a fresh consent and PKCE", () => {
    const url = new URL(
      authorizeUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5000", state: "s", codeChallenge: "ch" }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    );
  });

  it("derives the challenge from the verifier", async () => {
    const { verifier, challenge } = pkcePair();
    const { createHash } = await import("node:crypto");
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("reads the code from the loopback request path when the state matches", () => {
    expect(codeFromCallback("/?state=s1&code=4%2F0Abc&scope=x", "s1")).toBe("4/0Abc");
  });

  it("refuses a callback from another login attempt", () => {
    expect(() => codeFromCallback("/?state=s2&code=c", "s1")).toThrow(/state/);
  });

  it("reports Google's error when the user declined", () => {
    expect(() => codeFromCallback("/?state=s1&error=access_denied", "s1")).toThrow(/access_denied/);
  });

  it("refreshes within five minutes of expiry", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    expect(needsRefresh({ accessExpiresAt: "2026-10-23T12:04:00Z" }, now)).toBe(true);
    expect(needsRefresh({ accessExpiresAt: "2026-10-23T13:00:00Z" }, now)).toBe(false);
  });

  const app = { clientId: "id", clientSecret: "secret" };

  it("throws the token endpoint's own error", async () => {
    const f = mockFetch([{ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }]);
    await expect(
      exchangeCode({ ...app, code: "c", redirectUri: "r", codeVerifier: "v", fetch: f as never }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("refuses a first sign-in without a refresh token", async () => {
    const f = mockFetch([{ body: { access_token: "a", expires_in: 3599, scope: "s" } }]);
    await expect(
      exchangeCode({ ...app, code: "c", redirectUri: "r", codeVerifier: "v", fetch: f as never }),
    ).rejects.toThrow(/refresh token/);
  });

  it("keeps the stored refresh token when a refresh returns none", async () => {
    const f = mockFetch([{ body: { access_token: "a2", expires_in: 3599, scope: "s" } }]);
    const token = await refreshAccessToken({ ...app, refreshToken: "r1", fetch: f as never });
    expect(token).toMatchObject({ accessToken: "a2", refreshToken: "r1" });
  });
});

describe("uploadDraft", () => {
  it("parses the 308 Range header", () => {
    expect(nextOffset("bytes=0-8388607")).toBe(8 * MB);
    expect(nextOffset(null)).toBe(0);
  });

  it("starts a private resumable session and sends the file in 256 KiB-aligned chunks", async () => {
    const size = 20 * MB;
    const f = mockFetch([
      { headers: { location: "https://upload.test/session" } },
      { status: 308, headers: { range: `bytes=0-${8 * MB - 1}` } },
      { status: 308, headers: { range: `bytes=0-${16 * MB - 1}` } },
      { body: { id: "vid1" } },
    ]);
    const yt = createYouTubeContent({ accessToken: "t", fetch: f as never });
    const result = await yt.uploadDraft(new Uint8Array(size), { title: "Clip" });

    expect(result).toEqual({ videoId: "vid1", studioUrl: "https://studio.youtube.com/video/vid1/edit" });
    const [initUrl, init] = f.mock.calls[0];
    expect(String(initUrl)).toContain("uploadType=resumable");
    expect(JSON.parse(init.body).status).toEqual({ privacyStatus: "private", selfDeclaredMadeForKids: false });
    expect(init.headers["X-Upload-Content-Length"]).toBe(String(size));

    const ranges = f.mock.calls.slice(1).map(([, i]) => i.headers["Content-Range"]);
    expect(ranges).toEqual([
      `bytes 0-${8 * MB - 1}/${size}`,
      `bytes ${8 * MB}-${16 * MB - 1}/${size}`,
      `bytes ${16 * MB}-${size - 1}/${size}`,
    ]);
    expect(f.mock.calls.slice(1).every(([, i]) => i.redirect === "manual")).toBe(true);
  });

  it("resumes from the byte Google reports, not the byte it was sent", async () => {
    const size = 10 * MB;
    const f = mockFetch([
      { headers: { location: "https://upload.test/session" } },
      { status: 308, headers: { range: `bytes=0-${4 * MB - 1}` } },
      { body: { id: "vid2" } },
    ]);
    await createYouTubeContent({ accessToken: "t", fetch: f as never }).uploadDraft(new Uint8Array(size), {
      title: "Clip",
    });
    expect(f.mock.calls[2][1].headers["Content-Range"]).toBe(`bytes ${4 * MB}-${size - 1}/${size}`);
  });

  it("throws Google's reason when the session is refused", async () => {
    const f = mockFetch([
      { status: 403, body: { error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } } },
    ]);
    await expect(
      createYouTubeContent({ accessToken: "t", fetch: f as never }).uploadDraft(new Uint8Array(10), { title: "x" }),
    ).rejects.toThrow(/403 quotaExceeded/);
  });

  it("refuses an empty file", async () => {
    const yt = createYouTubeContent({ accessToken: "t", fetch: mockFetch([]) as never });
    await expect(yt.uploadDraft(new Uint8Array(0), { title: "x" })).rejects.toThrow(/empty/);
  });
});

describe("reads", () => {
  it("lists uploads across playlist pages and joins their stats", async () => {
    const f = mockFetch([
      { body: { items: [{ id: "UC1", contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] } },
      { body: { items: [{ contentDetails: { videoId: "a" } }], nextPageToken: "p2" } },
      { body: { items: [{ contentDetails: { videoId: "b" } }] } },
      {
        body: {
          items: [
            { id: "a", status: { privacyStatus: "private" }, statistics: { viewCount: "12" } },
            { id: "b", status: { privacyStatus: "public" }, statistics: { viewCount: "3" } },
          ],
        },
      },
    ]);
    const videos = await createYouTubeContent({ accessToken: "t", fetch: f as never }).listVideos();
    expect(videos.map((v) => [v.id, v.privacyStatus, v.viewCount])).toEqual([
      ["a", "private", 12],
      ["b", "public", 3],
    ]);
    expect(String(f.mock.calls[2][0])).toContain("pageToken=p2");
  });

  it("reports a missing video instead of an empty status", async () => {
    const f = mockFetch([{ body: { items: [] } }]);
    await expect(createYouTubeContent({ accessToken: "t", fetch: f as never }).getUploadStatus("x")).rejects.toThrow(
      /videoNotFound/,
    );
  });
});

describe("parseEnv", () => {
  it("reads keys, strips quotes and skips comments", () => {
    expect(parseEnv('# app\nYOUTUBE_CLIENT_ID="abc"\nYOUTUBE_CLIENT_SECRET=s=1\n')).toEqual({
      YOUTUBE_CLIENT_ID: "abc",
      YOUTUBE_CLIENT_SECRET: "s=1",
    });
  });
});
