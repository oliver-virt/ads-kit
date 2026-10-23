#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import { authorizeUrl, codeFromCallback, createYouTubeContent, exchangeCode, pkcePair } from "./index.js";
import { profileFromEnv, type Profile } from "./store.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const USAGE = `youtube-content ${VERSION}

usage: youtube-content <command> [--profile <name>]

  auth                          sign in to the YouTube channel (opens a browser)
  upload <video> [--title <t>]  upload a video as private, for the owner to publish in YouTube Studio
  status <id>                   processing state and privacy of an upload
  stats                         channel stats and every upload's views, likes and comments
  mcp                           run the MCP server on stdio

The profile defaults to $YOUTUBE_PROFILE, then "default". Credentials: ~/.config/youtube-content-kit/<profile>/credentials.env`;

/** Waits for Google's redirect on a loopback port, the flow Google documents for desktop apps. */
async function auth(profile: Profile): Promise<void> {
  const app = profile.credentials();
  const state = randomBytes(16).toString("hex");
  const pkce = pkcePair();
  let received: (url: string) => void = () => {};
  const callback = new Promise<string>((resolve) => {
    received = resolve;
  });
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Signed in. You can close this tab.");
    received(req.url ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = authorizeUrl({
    clientId: app.clientId,
    redirectUri,
    state,
    codeChallenge: pkce.challenge,
    scopes: app.scopes,
  });
  console.log(`Opening Google for profile "${profile.name}". Pick the account that owns the channel.`);
  console.log(`If nothing opens: ${url}\n`);
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  try {
    const code = codeFromCallback(await callback, state);
    const token = await exchangeCode({ ...app, code, redirectUri, codeVerifier: pkce.verifier });
    profile.saveToken(token);
    const channel = await createYouTubeContent({ accessToken: token.accessToken }).getChannel();
    console.log(`Signed in to ${channel.title ?? channel.id}. Scopes: ${token.scope}.`);
  } finally {
    server.close();
  }
}

async function upload(profile: Profile, file: string, title?: string): Promise<void> {
  const video = new Uint8Array(await readFile(file));
  const yt = createYouTubeContent({ accessToken: await profile.accessToken() });
  const { videoId, studioUrl } = await yt.uploadDraft(
    video,
    { title: title ?? basename(file, extname(file)) },
    file.endsWith(".mov") ? "video/quicktime" : "video/mp4",
  );
  console.log(`Uploaded ${(video.byteLength / 1024 / 1024).toFixed(1)} MB as private. video id: ${videoId}`);
  const status = await yt.waitForProcessing(videoId);
  if (status.uploadStatus === "failed" || status.uploadStatus === "rejected") {
    throw new Error(`YouTube ${status.uploadStatus} the video: ${status.failureReason ?? status.rejectionReason}`);
  }
  console.log(`${status.uploadStatus === "processed" ? "Processed" : "Still processing"}. Review and publish: ${studioUrl}`);
}

async function stats(profile: Profile): Promise<void> {
  const yt = createYouTubeContent({ accessToken: await profile.accessToken() });
  const [channel, videos] = await Promise.all([yt.getChannel(), yt.listVideos()]);
  console.log(`${channel.title}: ${channel.subscriberCount} subscribers, ${channel.viewCount} views, ${channel.videoCount} videos\n`);
  console.table(
    videos.map((v) => ({
      published: v.publishedAt?.slice(0, 10),
      privacy: v.privacyStatus,
      views: v.viewCount,
      likes: v.likeCount,
      comments: v.commentCount,
      title: (v.title ?? "").slice(0, 40),
      url: v.url,
    })),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { profile: { type: "string" }, title: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [command, arg] = positionals;
  const profile = profileFromEnv(values.profile);
  if (values.help || !command) return void console.log(USAGE);
  if (command === "auth") return auth(profile);
  if (command === "upload" && arg) return upload(profile, arg, values.title);
  if (command === "status" && arg) {
    const yt = createYouTubeContent({ accessToken: await profile.accessToken() });
    return void console.log(await yt.getUploadStatus(arg));
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
