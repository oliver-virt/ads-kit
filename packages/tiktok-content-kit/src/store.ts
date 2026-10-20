/**
 * Local credential store, one folder per TikTok account ("profile"), readable only by the owner:
 *   ~/.config/tiktok-content-kit/<profile>/credentials.env   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI
 *   ~/.config/tiktok-content-kit/<profile>/token.json        written by `auth`, refreshed when it nears expiry
 * TIKTOK_CONTENT_HOME overrides the root.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SCOPES,
  needsRefresh,
  refreshAccessToken,
  type TokenSet,
} from "./index.js";

export interface AppCredentials {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export class Profile {
  readonly dir: string;

  constructor(readonly name: string) {
    this.dir = join(process.env.TIKTOK_CONTENT_HOME ?? join(homedir(), ".config", "tiktok-content-kit"), name);
  }

  get credentialsFile(): string {
    return join(this.dir, "credentials.env");
  }

  get tokenFile(): string {
    return join(this.dir, "token.json");
  }

  credentials(): AppCredentials {
    if (!existsSync(this.credentialsFile)) {
      throw new Error(
        `No credentials for profile "${this.name}". Create ${this.credentialsFile} with TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI.`,
      );
    }
    const env = parseEnv(readFileSync(this.credentialsFile, "utf8"));
    const clientKey = env.TIKTOK_CLIENT_KEY;
    const clientSecret = env.TIKTOK_CLIENT_SECRET;
    const redirectUri = env.TIKTOK_REDIRECT_URI;
    if (!clientKey || !clientSecret || !redirectUri) {
      throw new Error(`${this.credentialsFile} needs TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI.`);
    }
    const scopes = env.TIKTOK_SCOPES ? env.TIKTOK_SCOPES.split(",").map((s) => s.trim()) : DEFAULT_SCOPES;
    return { clientKey, clientSecret, redirectUri, scopes };
  }

  saveToken(token: TokenSet): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.tokenFile, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.tokenFile, 0o600);
  }

  token(): TokenSet {
    if (!existsSync(this.tokenFile)) {
      throw new Error(`Profile "${this.name}" is not signed in. Run: tiktok-content auth --profile ${this.name}`);
    }
    return JSON.parse(readFileSync(this.tokenFile, "utf8")) as TokenSet;
  }

  /** A valid access token, refreshed and saved when it is within five minutes of expiry. */
  async accessToken(f: typeof fetch = fetch): Promise<string> {
    const stored = this.token();
    if (!needsRefresh(stored)) return stored.accessToken;
    if (Date.parse(stored.refreshExpiresAt) < Date.now()) {
      throw new Error(`The sign-in for profile "${this.name}" expired. Run: tiktok-content auth --profile ${this.name}`);
    }
    const { clientKey, clientSecret } = this.credentials();
    const fresh = await refreshAccessToken({ clientKey, clientSecret, refreshToken: stored.refreshToken, fetch: f });
    this.saveToken(fresh);
    return fresh.accessToken;
  }
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function profileFromEnv(argvProfile?: string): Profile {
  return new Profile(argvProfile ?? process.env.TIKTOK_PROFILE ?? "default");
}
