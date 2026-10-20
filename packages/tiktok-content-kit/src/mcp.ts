import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { createTikTokContent } from "./index.js";
import type { Profile } from "./store.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export async function serveMcp(profile: Profile, version: string): Promise<void> {
  const client = async () => createTikTokContent({ accessToken: await profile.accessToken() });
  const server = new McpServer({ name: "tiktok-content", version });

  server.registerTool(
    "upload_draft",
    {
      description:
        "Upload a local video file to the TikTok account's inbox as a draft. Nothing is posted: the account owner adds sound and caption and posts it in the TikTok app. Waits until TikTok has delivered it to the inbox.",
      inputSchema: z.object({ path: z.string().describe("Absolute path to an .mp4 or .mov file") }),
    },
    async ({ path }) => {
      const video = new Uint8Array(await readFile(path));
      const tt = await client();
      const { publishId } = await tt.uploadDraft(video, path.endsWith(".mov") ? "video/quicktime" : "video/mp4");
      const status = await tt.waitForPublish(publishId);
      return text({ publishId, ...status });
    },
  );

  server.registerTool(
    "upload_status",
    {
      description: "Read the state of an earlier upload by its publish_id.",
      inputSchema: z.object({ publish_id: z.string() }),
    },
    async ({ publish_id }) => text(await (await client()).getPublishStatus(publish_id)),
  );

  server.registerTool(
    "account_stats",
    {
      description: "The account's display name, followers, following, total likes and video count.",
      inputSchema: z.object({}),
    },
    async () => text(await (await client()).getUser()),
  );

  server.registerTool(
    "list_videos",
    {
      description:
        "The account's public videos, newest first, with views, likes, comments (count only), shares, duration and link.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
    },
    async ({ limit }) => text(await (await client()).listAllVideos(limit)),
  );

  await server.connect(new StdioServerTransport());
}
