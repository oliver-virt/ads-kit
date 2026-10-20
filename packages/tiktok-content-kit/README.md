# tiktok-content-kit

Typed client, CLI and MCP server for a TikTok account's own content: upload videos as drafts and read account and per-video stats. Zero-config beyond one TikTok developer app; credentials stay in your home folder.

| | |
|---|---|
| Upload drafts | Content Posting API "Upload" (`video.upload`): the video lands in the account's TikTok inbox and the owner adds sound and caption and posts it. Works before TikTok's app review. |
| Stats | Display API: followers, likes, video count (`user.info.stats`); each public video's views, likes, comment count and shares (`video.list`). |
| Not here | Comment text and replies (TikTok Business API), direct posting (needs app review), ads (see [`tiktok-ads-kit`](../tiktok-ads-kit)). |

## Setup

1. On developers.tiktok.com create an app with Login Kit and Content Posting API, scopes `user.info.basic`, `user.info.stats`, `video.list`, `video.upload`, and a Web redirect URI on a domain you own (any page, even a 404: the code rides in its address). Use a Sandbox and add the account as a target user to skip review.
2. Write `~/.config/tiktok-content-kit/<profile>/credentials.env`, mode 600:

```
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_REDIRECT_URI=https://example.com/tiktok-callback
```

3. Sign in once: `npx tiktok-content-kit auth --profile <profile>` (the bin is `tiktok-content`). The sign-in lasts a year and refreshes itself.

## CLI

```
tiktok-content auth            --profile brand
tiktok-content upload clip.mp4 --profile brand
tiktok-content status <publish_id>
tiktok-content stats
tiktok-content mcp
```

`--profile` falls back to `$TIKTOK_PROFILE`, then `default`. `$TIKTOK_CONTENT_HOME` moves the store.

## MCP

```json
"tiktok": {
  "command": "npx",
  "args": ["-y", "tiktok-content-kit@0.1.0", "mcp"],
  "env": { "TIKTOK_PROFILE": "brand" }
}
```

Tools: `upload_draft` (local file path), `upload_status`, `account_stats`, `list_videos`. Nothing is ever posted publicly: uploads are drafts.

## Library

```ts
import { createTikTokContent } from "tiktok-content-kit";
import { Profile } from "tiktok-content-kit/store";

const tt = createTikTokContent({ accessToken: await new Profile("brand").accessToken() });
const { publishId } = await tt.uploadDraft(video);
await tt.waitForPublish(publishId);
const videos = await tt.listAllVideos();
```

Errors throw `TikTokContentError` with TikTok's own code and message (TikTok often answers HTTP 200 with the error in the body).

## License

MIT
