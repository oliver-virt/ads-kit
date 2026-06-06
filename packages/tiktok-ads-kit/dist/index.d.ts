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
export interface TikTokAdsConfig {
    /** Long-lived advertiser access token (Marketing API). */
    accessToken: string;
    /** Advertiser account id all calls are scoped to. */
    advertiserId: string;
    /** Override for testing / sandbox (`https://sandbox-ads.tiktok.com/open_api/v1.3`). */
    baseUrl?: string;
    /** Custom fetch (defaults to global fetch). Reports are NOT cached by the kit. */
    fetch?: typeof fetch;
}
export interface AdvertiserInfo {
    advertiser_id: string;
    name: string;
    currency: string;
    balance: number;
}
export interface Campaign {
    campaign_id: string;
    campaign_name: string;
    operation_status: string;
    budget: number;
    budget_mode: string;
}
export interface AdGroup {
    adgroup_id: string;
    adgroup_name: string;
    campaign_id: string;
    operation_status: string;
    optimization_goal?: string;
    budget?: number;
    budget_mode?: string;
    age_groups?: string[];
    gender?: string;
    schedule_type?: string;
    schedule_start_time?: string;
    schedule_end_time?: string;
    secondary_status?: string;
}
export interface Ad {
    ad_id: string;
    ad_name: string;
    campaign_id: string;
    adgroup_id: string;
    operation_status: string;
    video_id?: string;
    ad_text?: string;
    /** Spark / Smart+ ads reference an organic TikTok post instead of an upload. */
    tiktok_item_id?: string;
    identity_id?: string;
    identity_type?: string;
}
export interface VideoInfo {
    video_id: string;
    video_cover_url: string;
    preview_url: string;
    duration: number;
}
export interface PostInfo {
    item_id: string;
    cover_url?: string;
    post_url: string;
}
export interface PixelEvent {
    event_type?: string | null;
    optimization_event?: string | null;
    name?: string;
    statistic_type?: string;
}
export interface Pixel {
    pixel_id: string;
    pixel_name: string;
    activity_status: string;
    events?: PixelEvent[];
}
export interface PixelEventStat {
    pixel_event_type: string | null;
    total_count: number;
    attributed_count: number;
    browser_event_total_count: number;
    server_event_total_count: number;
}
export interface AutomatedRule {
    rule_id: string;
    name: string;
    rule_status?: string;
    rule_exec_info?: object;
    conditions?: object[];
    actions?: object[];
    apply_objects?: object[];
}
export declare const METRICS: readonly ["spend", "impressions", "clicks", "ctr", "cpc", "conversion"];
export type Metric = (typeof METRICS)[number];
export interface ReportRow {
    dimensions: Record<string, string>;
    /** TikTok returns metric values as strings. Keys follow the requested metric set. */
    metrics: Record<Metric, string> & Record<string, string>;
}
export type DataLevel = "AUCTION_ADVERTISER" | "AUCTION_CAMPAIGN" | "AUCTION_ADGROUP" | "AUCTION_AD";
export declare const AGE_GROUPS: readonly ["AGE_13_17", "AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"];
export type AgeGroup = (typeof AGE_GROUPS)[number];
export type EntityLevel = "campaign" | "adgroup" | "ad";
export type OperationStatus = "ENABLE" | "DISABLE";
export type TikTokAdsClient = ReturnType<typeof createTikTokAds>;
export declare function createTikTokAds(config: TikTokAdsConfig): {
    getAdvertiserInfo(): Promise<AdvertiserInfo | undefined>;
    getCampaigns(): Promise<Campaign[]>;
    getAdGroups(campaignId?: string): Promise<AdGroup[]>;
    getAds(campaignId?: string): Promise<Ad[]>;
    getVideoInfo(videoIds: string[]): Promise<VideoInfo[]>;
    /** Cover image + canonical link for an organic post used by a Spark ad. */
    getPostInfo(identityId: string, identityType: string, itemId: string): Promise<PostInfo>;
    /**
     * Basic report. `stat_time_day` dimensions cap at 30-day spans — chunk
     * longer windows yourself.
     */
    getReport(opts: {
        dataLevel: DataLevel;
        dimensions: string[];
        startDate: string;
        endDate: string;
        campaignIds?: string[];
        /** Override the default metric set (e.g. ["reach", "frequency"]). */
        metrics?: string[];
    }): Promise<ReportRow[]>;
    /** Audience breakdowns: age, gender, placement, province_id, ... */
    getAudienceReport(dimensions: string[], startDate: string, endDate: string): Promise<ReportRow[]>;
    /** location_id → human name for countries + provinces. */
    getRegionNames(): Promise<Map<string, string>>;
    getPixels(): Promise<Pixel[]>;
    /** Per-event fire counts. Date ranges cap at 28 days. */
    getPixelEventStats(pixelId: string, startDate: string, endDate: string): Promise<PixelEventStat[]>;
    getRules(): Promise<AutomatedRule[]>;
    updateEntityStatus(level: EntityLevel, ids: string[], status: OperationStatus): Promise<void>;
    updateAdGroupBudget(adgroupId: string, budget: number, budgetMode?: string): Promise<void>;
    /**
     * Update age targeting. Falls back to the Smart+ endpoint automatically —
     * Smart+ ad groups reject `/adgroup/update/` and need targeting nested
     * under `targeting_spec`.
     */
    updateAdGroupAgeGroups(adgroupId: string, ageGroups: AgeGroup[]): Promise<void>;
    /** Extend or remove the delivery window. Smart+ fallback included. */
    updateAdGroupSchedule(adgroupId: string, endTime: string | null): Promise<void>;
    createCampaign(opts: {
        name: string;
        objective?: string;
    }): Promise<{
        campaign_id: string;
    }>;
    createAdGroup(opts: {
        campaignId: string;
        name: string;
        dailyBudget: number;
        optimizationGoal: string;
        /** Country / province location ids — required, no implicit default. */
        locationIds: string[];
        pixelId?: string;
        optimizationEvent?: string;
        ageGroups?: AgeGroup[];
        scheduleStartTime: string;
        /** Created paused by default — flip to "ENABLE" to go live immediately. */
        operationStatus?: OperationStatus;
    }): Promise<{
        adgroup_id: string;
    }>;
    /** Spark ad: boost an organic TikTok post as an ad. */
    createSparkAd(opts: {
        adgroupId: string;
        adName: string;
        identityId: string;
        identityType?: string;
        tiktokItemId: string;
        adText?: string;
        landingPageUrl: string;
        callToAction?: string;
    }): Promise<{
        ad_ids?: string[];
    }>;
    /** Create an automated rule (payload passed through verbatim). */
    createRule(payload: object): Promise<object>;
    /** Upload a video file for non-spark ads (multipart). */
    uploadVideo(file: File): Promise<{
        video_id: string;
    }[]>;
};
