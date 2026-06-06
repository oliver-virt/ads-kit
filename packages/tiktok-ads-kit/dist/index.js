/**
 * tiktok-ads-kit — typed, quirk-aware TikTok Marketing API client.
 *
 * The official API has sharp edges this client absorbs for you:
 * - TikTok answers HTTP 200 with errors in the body (`code !== 0`)
 * - Report endpoints use a list-of-filters `filtering` format; entity
 *   endpoints use a plain object — mixing them up fails cryptically
 * - `stat_time_day` reports cap at 30-day spans; pixel event stats at 28
 * - Smart+ campaigns reject the standard update endpoints and need their
 *   `/smart_plus/...` twins (with targeting nested under `targeting_spec`)
 * - Metric values arrive as strings
 */
const DEFAULT_BASE = "https://business-api.tiktok.com/open_api/v1.3";
export const METRICS = [
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "conversion",
];
export const AGE_GROUPS = [
    "AGE_13_17",
    "AGE_18_24",
    "AGE_25_34",
    "AGE_35_44",
    "AGE_45_54",
    "AGE_55_100",
];
// ---------- client factory ----------
export function createTikTokAds(config) {
    const base = config.baseUrl ?? DEFAULT_BASE;
    const doFetch = config.fetch ?? fetch;
    const { accessToken, advertiserId } = config;
    if (!accessToken)
        throw new Error("tiktok-ads-kit: accessToken is required");
    if (!advertiserId)
        throw new Error("tiktok-ads-kit: advertiserId is required");
    async function parse(res) {
        if (!res.ok)
            throw new Error(`TikTok HTTP ${res.status}`);
        let json;
        try {
            json = (await res.json());
        }
        catch {
            throw new Error(`TikTok returned non-JSON response (HTTP ${res.status})`);
        }
        if (json.code !== 0) {
            throw new Error(`TikTok API error ${json.code}: ${json.message}`);
        }
        return json.data;
    }
    async function get(path, params) {
        const url = new URL(`${base}${path}`);
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined)
                continue;
            url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
        }
        return parse(await doFetch(url, { headers: { "Access-Token": accessToken } }));
    }
    async function post(path, body) {
        return parse(await doFetch(`${base}${path}`, {
            method: "POST",
            headers: {
                "Access-Token": accessToken,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        }));
    }
    return {
        // ---------- reads ----------
        async getAdvertiserInfo() {
            const data = await get("/advertiser/info/", {
                advertiser_ids: [advertiserId],
            });
            return data.list[0];
        },
        async getCampaigns() {
            const data = await get("/campaign/get/", {
                advertiser_id: advertiserId,
                page_size: 100,
            });
            return data.list ?? [];
        },
        async getAdGroups(campaignId) {
            const data = await get("/adgroup/get/", {
                advertiser_id: advertiserId,
                page_size: 100,
                // Entity endpoints take a plain-object filter (unlike reports).
                filtering: campaignId ? { campaign_ids: [campaignId] } : undefined,
            });
            return data.list ?? [];
        },
        async getAds(campaignId) {
            const data = await get("/ad/get/", {
                advertiser_id: advertiserId,
                page_size: 100,
                filtering: campaignId ? { campaign_ids: [campaignId] } : undefined,
            });
            return data.list ?? [];
        },
        async getVideoInfo(videoIds) {
            if (videoIds.length === 0)
                return [];
            // The endpoint caps at 60 ids per call.
            const chunks = [];
            for (let i = 0; i < videoIds.length; i += 60) {
                chunks.push(videoIds.slice(i, i + 60));
            }
            const results = await Promise.all(chunks.map((ids) => get("/file/video/ad/info/", {
                advertiser_id: advertiserId,
                video_ids: ids,
            })));
            return results.flatMap((r) => r.list ?? []);
        },
        /** Cover image + canonical link for an organic post used by a Spark ad. */
        async getPostInfo(identityId, identityType, itemId) {
            const data = await get("/identity/video/info/", {
                advertiser_id: advertiserId,
                identity_type: identityType,
                identity_id: identityId,
                item_id: itemId,
            });
            const detail = data.video_detail;
            const cover = detail?.video_info?.poster_url ??
                detail?.carousel_info?.image_info?.[0]?.image_url;
            return {
                item_id: itemId,
                cover_url: cover,
                post_url: `https://www.tiktok.com/@_/video/${itemId}`,
            };
        },
        /**
         * Basic report. `stat_time_day` dimensions cap at 30-day spans — chunk
         * longer windows yourself.
         */
        async getReport(opts) {
            const data = await get("/report/integrated/get/", {
                advertiser_id: advertiserId,
                report_type: "BASIC",
                data_level: opts.dataLevel,
                dimensions: opts.dimensions,
                metrics: opts.metrics ?? [...METRICS],
                start_date: opts.startDate,
                end_date: opts.endDate,
                // Reports use a list-of-filters format, unlike entity endpoints.
                filtering: opts.campaignIds
                    ? [
                        {
                            field_name: "campaign_ids",
                            filter_type: "IN",
                            filter_value: JSON.stringify(opts.campaignIds),
                        },
                    ]
                    : undefined,
                page_size: 200,
            });
            return data.list ?? [];
        },
        /** Audience breakdowns: age, gender, placement, province_id, ... */
        async getAudienceReport(dimensions, startDate, endDate) {
            const data = await get("/report/integrated/get/", {
                advertiser_id: advertiserId,
                report_type: "AUDIENCE",
                data_level: "AUCTION_ADVERTISER",
                dimensions,
                metrics: [...METRICS],
                start_date: startDate,
                end_date: endDate,
                page_size: 200,
            });
            return data.list ?? [];
        },
        /** location_id → human name for countries + provinces. */
        async getRegionNames() {
            const data = await get("/tool/region/", {
                advertiser_id: advertiserId,
                placements: ["PLACEMENT_TIKTOK"],
                objective_type: "TRAFFIC",
                level_range: "TO_PROVINCE",
            });
            return new Map((data.region_info ?? []).map((r) => [r.location_id, r.name]));
        },
        async getPixels() {
            const data = await get("/pixel/list/", {
                advertiser_id: advertiserId,
            });
            return data.pixels ?? [];
        },
        /** Per-event fire counts. Date ranges cap at 28 days. */
        async getPixelEventStats(pixelId, startDate, endDate) {
            const data = await get("/pixel/event/stats/", {
                advertiser_id: advertiserId,
                pixel_ids: [pixelId],
                date_range: { start_date: startDate, end_date: endDate },
            });
            return data.list?.[0]?.statistics ?? [];
        },
        async getRules() {
            const data = await get("/optimizer/rule/list/", {
                advertiser_id: advertiserId,
                page: 1,
                page_size: 50,
            });
            return data.list ?? [];
        },
        // ---------- writes ----------
        async updateEntityStatus(level, ids, status) {
            await post(`/${level}/status/update/`, {
                advertiser_id: advertiserId,
                [`${level}_ids`]: ids,
                operation_status: status,
            });
        },
        async updateAdGroupBudget(adgroupId, budget, 
        /** Pass the ad group's existing mode to avoid switching it. */
        budgetMode = "BUDGET_MODE_DAY") {
            await post("/adgroup/budget/update/", {
                advertiser_id: advertiserId,
                adgroup_ids: [adgroupId],
                budget,
                budget_mode: budgetMode,
            });
        },
        /**
         * Update age targeting. Falls back to the Smart+ endpoint automatically —
         * Smart+ ad groups reject `/adgroup/update/` and need targeting nested
         * under `targeting_spec`.
         */
        async updateAdGroupAgeGroups(adgroupId, ageGroups) {
            try {
                await post("/adgroup/update/", {
                    advertiser_id: advertiserId,
                    adgroup_id: adgroupId,
                    age_groups: ageGroups,
                });
            }
            catch (e) {
                if (e instanceof Error && e.message.includes("Smart Plus")) {
                    await post("/smart_plus/adgroup/update/", {
                        advertiser_id: advertiserId,
                        adgroup_id: adgroupId,
                        targeting_spec: { age_groups: ageGroups },
                    });
                    return;
                }
                throw e;
            }
        },
        /** Extend or remove the delivery window. Smart+ fallback included. */
        async updateAdGroupSchedule(adgroupId, endTime) {
            const body = endTime === null
                ? { schedule_type: "SCHEDULE_FROM_NOW" }
                : { schedule_type: "SCHEDULE_START_END", schedule_end_time: endTime };
            try {
                await post("/adgroup/update/", {
                    advertiser_id: advertiserId,
                    adgroup_id: adgroupId,
                    ...body,
                });
            }
            catch (e) {
                if (e instanceof Error && e.message.includes("Smart Plus")) {
                    await post("/smart_plus/adgroup/update/", {
                        advertiser_id: advertiserId,
                        adgroup_id: adgroupId,
                        ...body,
                    });
                    return;
                }
                throw e;
            }
        },
        async createCampaign(opts) {
            return post("/campaign/create/", {
                advertiser_id: advertiserId,
                campaign_name: opts.name,
                objective_type: opts.objective ?? "TRAFFIC",
                budget_mode: "BUDGET_MODE_INFINITE",
            });
        },
        async createAdGroup(opts) {
            return post("/adgroup/create/", {
                advertiser_id: advertiserId,
                campaign_id: opts.campaignId,
                adgroup_name: opts.name,
                promotion_type: "WEBSITE",
                placement_type: "PLACEMENT_TYPE_AUTOMATIC",
                location_ids: opts.locationIds,
                budget_mode: "BUDGET_MODE_DAY",
                budget: opts.dailyBudget,
                schedule_type: "SCHEDULE_FROM_NOW",
                schedule_start_time: opts.scheduleStartTime,
                optimization_goal: opts.optimizationGoal,
                // CLICK optimization only accepts CPC billing; conversion goals use OCPM.
                billing_event: opts.optimizationGoal === "CLICK" ? "CPC" : "OCPM",
                bid_type: "BID_TYPE_NO_BID",
                pacing: "PACING_MODE_SMOOTH",
                operation_status: opts.operationStatus ?? "DISABLE",
                pixel_id: opts.pixelId,
                optimization_event: opts.optimizationEvent,
                age_groups: opts.ageGroups,
            });
        },
        /** Spark ad: boost an organic TikTok post as an ad. */
        async createSparkAd(opts) {
            return post("/ad/create/", {
                advertiser_id: advertiserId,
                adgroup_id: opts.adgroupId,
                creatives: [
                    {
                        ad_name: opts.adName,
                        identity_type: opts.identityType ?? "TT_USER",
                        identity_id: opts.identityId,
                        ad_format: opts.adFormat ?? "SINGLE_VIDEO",
                        tiktok_item_id: opts.tiktokItemId,
                        ad_text: opts.adText,
                        landing_page_url: opts.landingPageUrl,
                        call_to_action: opts.callToAction ?? "LEARN_MORE",
                    },
                ],
            });
        },
        /** Create an automated rule (payload passed through verbatim). */
        async createRule(payload) {
            return post("/optimizer/rule/create/", {
                advertiser_id: advertiserId,
                ...payload,
            });
        },
        /** Upload a video file for non-spark ads (multipart). */
        async uploadVideo(file) {
            const form = new FormData();
            form.set("advertiser_id", advertiserId);
            form.set("upload_type", "UPLOAD_BY_FILE");
            form.set("video_file", file);
            return parse(await doFetch(`${base}/file/video/ad/upload/`, {
                method: "POST",
                headers: { "Access-Token": accessToken },
                body: form,
            }));
        },
    };
}
