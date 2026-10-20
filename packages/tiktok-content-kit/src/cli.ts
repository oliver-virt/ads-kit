#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { authorizeUrl, codeFromCallback, createTikTokContent, exchangeCode } from "./index.js";
import { profileFromEnv, type Profile } from "./store.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const USAGE = `tiktok-content ${VERSION}

usage: tiktok-content <command> [--profile <name>]

  auth              sign in to the TikTok account (opens a browser, then asks for the redirect URL)
  upload <video>    upload a video to the account's inbox as a draft
  status <id>       state of an upload by publish_id
  stats             account stats and every video's views, likes, comments and shares
  mcp               run the MCP server on stdio

The profile defaults to $TIKTOK_PROFILE, then "default". Credentials: ~/.config/tiktok-content-kit/<profile>/credentials.env`;

async function auth(profile: Profile): Promise<void> {
  const app = profile.credentials();
  const state = randomBytes(16).toString("hex");
  const url = authorizeUrl({ clientKey: app.clientKey, redirectUri: app.redirectUri, state, scopes: app.scopes });
  console.log(`Opening TikTok for profile "${profile.name}". After you approve, the browser lands on ${app.redirectUri}.`);
  console.log(`If nothing opens: ${url}\n`);
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = await rl.question("Paste the full address the browser landed on: ");
  rl.close();
  const code = codeFromCallback(pasted, state);
  const token = await exchangeCode({ ...app, code });
  profile.saveToken(token);
  const user = await createTikTokContent({ accessToken: token.accessToken }).getUser();
  console.log(
    `Signed in as ${user.display_name ?? token.openId}. Scopes: ${token.scope}. Valid until ${token.refreshExpiresAt.slice(0, 10)}.`,
  );
}

async function upload(profile: Profile, file: string): Promise<void> {
  const video = new Uint8Array(await readFile(file));
  const tt = createTikTokContent({ accessToken: await profile.accessToken() });
  const { publishId } = await tt.uploadDraft(video, file.endsWith(".mov") ? "video/quicktime" : "video/mp4");
  console.log(`Uploaded ${(video.byteLength / 1024 / 1024).toFixed(1)} MB. publish_id: ${publishId}`);
  const status = await tt.waitForPublish(publishId);
  if (status.status === "FAILED") throw new Error(`TikTok rejected the video: ${status.fail_reason ?? "no reason given"}`);
  if (status.status.startsWith("PROCESSING")) {
    console.log(`Still processing. Check later: tiktok-content status ${publishId} --profile ${profile.name}`);
  } else {
    console.log("In the account's TikTok inbox. Open TikTok, add the sound and caption, and post.");
  }
}

async function stats(profile: Profile): Promise<void> {
  const tt = createTikTokContent({ accessToken: await profile.accessToken() });
  const [user, videos] = await Promise.all([tt.getUser(), tt.listAllVideos()]);
  console.log(
    `${user.display_name}: ${user.follower_count} followers, ${user.likes_count} likes, ${user.video_count} videos\n`,
  );
  console.table(
    videos.map((v) => ({
      posted: new Date(v.create_time * 1000).toISOString().slice(0, 10),
      views: v.view_count,
      likes: v.like_count,
      comments: v.comment_count,
      shares: v.share_count,
      title: (v.title ?? v.video_description ?? "").slice(0, 40),
      url: v.share_url,
    })),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { profile: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [command, arg] = positionals;
  const profile = profileFromEnv(values.profile);
  if (values.help || !command) return void console.log(USAGE);
  if (command === "auth") return auth(profile);
  if (command === "upload" && arg) return upload(profile, arg);
  if (command === "status" && arg) {
    const tt = createTikTokContent({ accessToken: await profile.accessToken() });
    return void console.log(await tt.getPublishStatus(arg));
  }
  if (command === "stats") return stats(profile);
  if (command === "mcp") {
    const { serveMcp } = await import("./mcp.js");
    return serveMcp(profile, VERSION);
  }
  console.error(USAGE);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
