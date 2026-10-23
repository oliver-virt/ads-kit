# youtube-content-kit

Typed client, CLI and MCP server for a YouTube channel's own content: upload videos as private drafts and read channel and per-video stats. Zero-config beyond one Google Cloud OAuth client; credentials stay in your home folder.

| | |
|---|---|
| Upload drafts | YouTube Data API `videos.insert`, resumable: the video lands on the channel as private and the owner publishes it in YouTube Studio. A vertical video up to 3 minutes becomes a Short. |
| Stats | Channel subscribers, views and video count; each upload's privacy, duration, views, likes and comment count (private uploads included). |
| Not here | Comments, playlists, thumbnails, live streams. |

## Before you rely on it

- **Audit.** Videos uploaded from a Google Cloud project created after 28 July 2020 that has not passed YouTube's compliance audit are locked as private, and the owner cannot publish them. Submit the [YouTube API Services audit form](https://support.google.com/youtube/contact/yt_api_form) once the client works.
- **7-day sign-in in Testing.** While the OAuth consent screen is in "Testing", Google revokes the refresh token after 7 days. Move it to "In production" (unverified is fine for your own channel; you click through a warning once) to keep the sign-in.
- **Quota.** `videos.insert` has its own bucket of 100 uploads a day; everything else shares 10,000 units.

## Setup

1. In Google Cloud: create a project, enable **YouTube Data API v3**, set up the OAuth consent screen (External; add the channel owner's Google account as a test user while in Testing), and create an OAuth client of type **Desktop app**.
2. Write `~/.config/youtube-content-kit/<profile>/credentials.env`, mode 600:

```
YOUTUBE_CLIENT_ID=...apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=...
```

3. Sign in once: `npx youtube-content-kit auth --profile <profile>` (the bin is `youtube-content`). It opens Google, listens on a loopback port for the redirect, and saves the token. Pick the account (or brand account) that owns the channel.

## CLI

```
youtube-content auth                         --profile brand
youtube-content upload clip.mp4 --title "…"  --profile brand
youtube-content status <video_id>
youtube-content stats
youtube-content mcp
```

`--profile` falls back to `$YOUTUBE_PROFILE`, then `default`. `$YOUTUBE_CONTENT_HOME` moves the store.

## MCP

```json
"youtube": {
  "command": "npx",
  "args": ["-y", "youtube-content-kit@0.1.0", "mcp"],
  "env": { "YOUTUBE_PROFILE": "brand" }
}
```

Tools: `upload_draft` (local file path, title, optional description, tags, category), `upload_status`, `channel_stats`, `list_videos`. Uploads are private; nothing is published.

## Library

```ts
import { createYouTubeContent } from "youtube-content-kit";
import { Profile } from "youtube-content-kit/store";

const yt = createYouTubeContent({ accessToken: await new Profile("brand").accessToken() });
const { videoId, studioUrl } = await yt.uploadDraft(video, { title: "…", categoryId: "27" });
await yt.waitForProcessing(videoId);
const videos = await yt.listVideos();
```

Errors throw `YouTubeContentError` with the HTTP status and Google's own reason (`quotaExceeded`, `uploadLimitExceeded`, …).

## License

MIT
