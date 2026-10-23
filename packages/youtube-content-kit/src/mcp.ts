import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { createYouTubeContent } from "./index.js";
import type { Profile } from "./store.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export async function serveMcp(profile: Profile, version: string): Promise<void> {
  const client = async () => createYouTubeContent({ accessToken: await profile.accessToken() });
  const server = new McpServer({ name: "youtube-content", version });

  server.registerTool(
    "upload_draft",
    {
      description:
        "Upload a local video file to the YouTube channel as a private video. Nothing is published: the owner reviews it in YouTube Studio and publishes it there. A vertical video up to 3 minutes becomes a Short. Waits until YouTube has processed it and returns the Studio link.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to an .mp4 or .mov file"),
        title: z.string().max(100),
        description: z.string().max(5000).optional(),
        tags: z.array(z.string()).optional(),
        category_id: z.string().optional().describe('YouTube category id, e.g. "27" Education. Default "22".'),
      }),
    },
    async ({ path, title, description, tags, category_id }) => {
      const video = new Uint8Array(await readFile(path));
      const yt = await client();
      const { videoId } = await yt.uploadDraft(
        video,
        { title, description, tags, categoryId: category_id },
        path.endsWith(".mov") ? "video/quicktime" : "video/mp4",
      );
      return text(await yt.waitForProcessing(videoId));
    },
  );

  server.registerTool(
    "upload_status",
    {
      description: "Read the processing state and privacy of an uploaded video by its id.",
      inputSchema: z.object({ video_id: z.string() }),
    },
    async ({ video_id }) => text(await (await client()).getUploadStatus(video_id)),
  );

  server.registerTool(
    "channel_stats",
    {
      description: "The channel's title, subscribers, total views and video count.",
      inputSchema: z.object({}),
    },
    async () => text(await (await client()).getChannel()),
  );

  server.registerTool(
    "list_videos",
    {
      description:
        "The channel's uploads, newest first, private ones included, with privacy, duration, views, likes, comment count and link.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
    },
    async ({ limit }) => text(await (await client()).listVideos(limit)),
  );

  await server.connect(new StdioServerTransport());
}
