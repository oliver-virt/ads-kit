import { describe, expect, it, vi } from "vitest";
import {
  authorizeUrl,
  chunkPlan,
  codeFromCallback,
  createTikTokContent,
  exchangeCode,
  needsRefresh,
} from "../src/index.js";
import { parseEnv } from "../src/store.js";

const MB = 1024 * 1024;
const ok = (data: unknown) => ({ data, error: { code: "ok", message: "" } });

function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  let i = 0;
  return vi.fn().mockImplementation(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { status: r.status ?? 200, ok: true, json: async () => r.body };
  });
}

describe("chunkPlan", () => {
  it("sends a file under 5 MB as one chunk of its own size", () => {
    expect(chunkPlan(3 * MB)).toEqual({ chunkSize: 3 * MB, count: 1, ranges: [[0, 3 * MB - 1]] });
  });

  it("sends a file up to 64 MB as one chunk", () => {
    expect(chunkPlan(64 * MB).count).toBe(1);
  });

  it("splits a larger file and folds the trailing bytes into the last chunk", () => {
    const size = 70 * MB + 123;
    const plan = chunkPlan(size);
    expect(plan.chunkSize).toBe(10 * MB);
    expect(plan.count).toBe(7);
    expect(plan.ranges.at(-1)).toEqual([60 * MB, size - 1]);
    expect(plan.ranges.every(([from], i) => from === i * 10 * MB)).toBe(true);
  });

  it("refuses an empty file", () => {
    expect(() => chunkPlan(0)).toThrow(/empty/);
  });
});

describe("OAuth helpers", () => {
  it("builds the authorize URL with comma-joined scopes", () => {
    const url = new URL(
      authorizeUrl({ clientKey: "ck", redirectUri: "https://x.test/cb", state: "s", scopes: ["a", "b"] }),
    );
    expect(url.searchParams.get("scope")).toBe("a,b");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  const cb = "https://x.test/cb/?code=abc%2A123&scopes=video.upload&state=s1";

  it("reads the URL-decoded code when the state matches", () => {
    expect(codeFromCallback(cb, "s1")).toBe("abc*123");
  });

  it("refuses a callback from another login attempt", () => {
    expect(() => codeFromCallback(cb, "s2")).toThrow(/state/);
  });

  it("reports TikTok's error when the user declined", () => {
    expect(() => codeFromCallback("https://x.test/cb?error=access_denied&state=s1", "s1")).toThrow(
      /access_denied/,
    );
  });

  it("refreshes within five minutes of expiry", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(needsRefresh({ accessExpiresAt: "2026-10-20T12:04:00Z" }, now)).toBe(true);
    expect(needsRefresh({ accessExpiresAt: "2026-10-20T13:00:00Z" }, now)).toBe(false);
  });

  it("throws the token endpoint's own error shape", async () => {
    const f = mockFetch([{ body: { error: "invalid_grant", error_description: "Code expired", log_id: "L1" } }]);
    await expect(
      exchangeCode({ clientKey: "k", clientSecret: "s", code: "c", redirectUri: "r", fetch: f as never }),
    ).rejects.toThrow("TikTok API error invalid_grant: Code expired (log L1)");
  });
});

describe("client", () => {
  it("throws the body error even on HTTP 200", async () => {
    const f = mockFetch([{ body: { data: {}, error: { code: "access_token_invalid", message: "expired" } } }]);
    const tt = createTikTokContent({ accessToken: "t", fetch: f as never });
    await expect(tt.getUser()).rejects.toThrow("TikTok API error access_token_invalid: expired");
  });

  it("uploads a draft: init, then each chunk with its Content-Range", async () => {
    const f = mockFetch([
      { body: ok({ publish_id: "p1", upload_url: "https://upload.test/u" }) },
      { status: 201 },
    ]);
    const tt = createTikTokContent({ accessToken: "t", fetch: f as never });
    const { publishId } = await tt.uploadDraft(new Uint8Array(1000));
    expect(publishId).toBe("p1");
    const [initUrl, initReq] = f.mock.calls[0];
    expect(String(initUrl)).toContain("/post/publish/inbox/video/init/");
    expect(JSON.parse(initReq.body).source_info).toEqual({
      source: "FILE_UPLOAD",
      video_size: 1000,
      chunk_size: 1000,
      total_chunk_count: 1,
    });
    const [putUrl, putReq] = f.mock.calls[1];
    expect(putUrl).toBe("https://upload.test/u");
    expect(putReq.headers["Content-Range"]).toBe("bytes 0-999/1000");
  });

  it("fails loudly when a chunk is rejected", async () => {
    const f = mockFetch([{ body: ok({ publish_id: "p1", upload_url: "https://upload.test/u" }) }, { status: 403 }]);
    const tt = createTikTokContent({ accessToken: "t", fetch: f as never });
    await expect(tt.uploadDraft(new Uint8Array(10))).rejects.toThrow(/chunk 1\/1/);
  });

  it("follows the video cursor until has_more is false", async () => {
    const v = (id: string) => ({ id, create_time: 1 });
    const f = mockFetch([
      { body: ok({ videos: [v("a"), v("b")], cursor: 99, has_more: true }) },
      { body: ok({ videos: [v("c")], cursor: 0, has_more: false }) },
    ]);
    const tt = createTikTokContent({ accessToken: "t", fetch: f as never });
    expect((await tt.listAllVideos()).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(JSON.parse(f.mock.calls[1][1].body).cursor).toBe(99);
  });

  it("waits while TikTok is still processing", async () => {
    const f = mockFetch([
      { body: ok({ status: "PROCESSING_UPLOAD" }) },
      { body: ok({ status: "SEND_TO_USER_INBOX" }) },
    ]);
    const tt = createTikTokContent({ accessToken: "t", fetch: f as never });
    expect((await tt.waitForPublish("p1", { intervalMs: 1 })).status).toBe("SEND_TO_USER_INBOX");
  });
});

describe("parseEnv", () => {
  it("reads KEY=value lines, ignoring comments and quotes", () => {
    expect(parseEnv('# app\nTIKTOK_CLIENT_KEY=abc\nTIKTOK_REDIRECT_URI="https://x.test/cb?a=1"\n')).toEqual({
      TIKTOK_CLIENT_KEY: "abc",
      TIKTOK_REDIRECT_URI: "https://x.test/cb?a=1",
    });
  });
});
