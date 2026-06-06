import { describe, expect, it, vi } from "vitest";
import { createTikTokAds } from "../src/index.js";

function mockFetch(bodies: unknown[]) {
  let i = 0;
  return vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => bodies[Math.min(i++, bodies.length - 1)],
  }));
}

const ok = (data: unknown) => ({ code: 0, message: "OK", data });

function client(bodies: unknown[]) {
  const f = mockFetch(bodies);
  const c = createTikTokAds({
    accessToken: "tok",
    advertiserId: "adv-1",
    fetch: f as unknown as typeof fetch,
  });
  return { c, f };
}

describe("transport", () => {
  it("sends Access-Token header and scopes to the advertiser", async () => {
    const { c, f } = client([ok({ list: [] })]);
    await c.getCampaigns();
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain("/campaign/get/");
    expect(String(url)).toContain("advertiser_id=adv-1");
    expect((init.headers as Record<string, string>)["Access-Token"]).toBe("tok");
  });

  it("throws the TikTok body error despite HTTP 200", async () => {
    const { c } = client([{ code: 40105, message: "Access token expired", data: {} }]);
    await expect(c.getCampaigns()).rejects.toThrow(
      "TikTok API error 40105: Access token expired",
    );
  });

  it("requires credentials at construction", () => {
    expect(() =>
      createTikTokAds({ accessToken: "", advertiserId: "x" }),
    ).toThrow(/accessToken/);
    expect(() =>
      createTikTokAds({ accessToken: "x", advertiserId: "" }),
    ).toThrow(/advertiserId/);
  });
});

describe("filtering formats", () => {
  it("entity endpoints use plain-object filtering", async () => {
    const { c, f } = client([ok({ list: [] })]);
    await c.getAdGroups("c-1");
    const url = new URL(String(f.mock.calls[0][0]));
    expect(url.searchParams.get("filtering")).toBe('{"campaign_ids":["c-1"]}');
  });

  it("report endpoints use list-of-filters format", async () => {
    const { c, f } = client([ok({ list: [] })]);
    await c.getReport({
      dataLevel: "AUCTION_ADGROUP",
      dimensions: ["adgroup_id"],
      startDate: "2026-01-01",
      endDate: "2026-01-07",
      campaignIds: ["c-1"],
    });
    const url = new URL(String(f.mock.calls[0][0]));
    expect(JSON.parse(url.searchParams.get("filtering")!)).toEqual([
      { field_name: "campaign_ids", filter_type: "IN", filter_value: '["c-1"]' },
    ]);
    expect(url.searchParams.get("report_type")).toBe("BASIC");
  });
});

describe("Smart+ fallbacks", () => {
  it("retries age targeting via the smart_plus endpoint", async () => {
    const { c, f } = client([
      { code: 40002, message: "This API does not support Upgraded Smart Plus ads.", data: {} },
      ok({}),
    ]);
    await c.updateAdGroupAgeGroups("ag-1", ["AGE_18_24"]);
    expect(f).toHaveBeenCalledTimes(2);
    const [url2, init2] = f.mock.calls[1];
    expect(String(url2)).toContain("/smart_plus/adgroup/update/");
    expect(JSON.parse(init2.body)).toEqual({
      advertiser_id: "adv-1",
      adgroup_id: "ag-1",
      targeting_spec: { age_groups: ["AGE_18_24"] },
    });
  });

  it("retries schedule changes via the smart_plus endpoint", async () => {
    const { c, f } = client([
      { code: 40002, message: "Smart Plus says no", data: {} },
      ok({}),
    ]);
    await c.updateAdGroupSchedule("ag-1", null);
    const [url2, init2] = f.mock.calls[1];
    expect(String(url2)).toContain("/smart_plus/adgroup/update/");
    expect(JSON.parse(init2.body).schedule_type).toBe("SCHEDULE_FROM_NOW");
  });
});

describe("budget", () => {
  it("sends object-list shape, falls back to smart_plus flat budget", async () => {
    const { c, f } = client([
      { code: 40002, message: "This API does not support Upgraded Smart Plus ads.", data: {} },
      ok({}),
    ]);
    await c.updateAdGroupBudget("ag-1", 125, "BUDGET_MODE_DYNAMIC_DAILY_BUDGET");
    const first = JSON.parse(f.mock.calls[0][1].body);
    expect(first.budget).toEqual([{ adgroup_id: "ag-1", budget: 125 }]);
    const second = JSON.parse(f.mock.calls[1][1].body);
    expect(String(f.mock.calls[1][0])).toContain("/smart_plus/adgroup/update/");
    expect(second.budget).toBe(125);
  });
});

describe("creation", () => {
  it("creates ad groups paused by default with explicit locations", async () => {
    const { c, f } = client([ok({ adgroup_id: "ag-9" })]);
    await c.createAdGroup({
      campaignId: "c-1",
      name: "Test",
      dailyBudget: 25,
      optimizationGoal: "CLICK",
      locationIds: ["294640"],
      scheduleStartTime: "2026-01-01 00:00:00",
    });
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.operation_status).toBe("DISABLE");
    expect(body.location_ids).toEqual(["294640"]);
    expect(body.billing_event).toBe("CPC"); // CLICK goal requires CPC billing
  });

  it("spark ads reference the organic post", async () => {
    const { c, f } = client([ok({ ad_ids: ["a-1"] })]);
    await c.createSparkAd({
      adgroupId: "ag-1",
      adName: "Spark",
      identityId: "ident-1",
      tiktokItemId: "item-7",
      landingPageUrl: "https://example.com/",
    });
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.creatives[0]).toMatchObject({
      identity_type: "TT_USER",
      tiktok_item_id: "item-7",
      ad_format: "SINGLE_VIDEO",
    });
  });
});

describe("posts + chunking", () => {
  it("resolves video poster, falls back to carousel image", async () => {
    const { c } = client([
      ok({ video_detail: { item_id: "i1", video_info: { poster_url: "https://cdn/p.jpg" } } }),
    ]);
    const info = await c.getPostInfo("ident", "TT_USER", "i1");
    expect(info.cover_url).toBe("https://cdn/p.jpg");
    expect(info.post_url).toBe("https://www.tiktok.com/@_/video/i1");
  });

  it("chunks video info lookups at 60 ids", async () => {
    const { c, f } = client([ok({ list: [] }), ok({ list: [] })]);
    await c.getVideoInfo(Array.from({ length: 61 }, (_, i) => `v${i}`));
    expect(f).toHaveBeenCalledTimes(2);
  });
});
