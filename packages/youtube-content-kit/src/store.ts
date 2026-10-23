/**
 * Local credential store, one folder per YouTube channel ("profile"), readable only by the owner:
 *   ~/.config/youtube-content-kit/<profile>/credentials.env   YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET (a Desktop OAuth client)
 *   ~/.config/youtube-content-kit/<profile>/token.json        written by `auth`, refreshed when it nears expiry
 * YOUTUBE_CONTENT_HOME overrides the root.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCOPES, needsRefresh, refreshAccessToken, type TokenSet } from "./index.js";

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export class Profile {
  readonly dir: string;

  constructor(readonly name: string) {
    this.dir = join(process.env.YOUTUBE_CONTENT_HOME ?? join(homedir(), ".config", "youtube-content-kit"), name);
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
        `No credentials for profile "${this.name}". Create ${this.credentialsFile} with YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.`,
      );
    }
    const env = parseEnv(readFileSync(this.credentialsFile, "utf8"));
    const clientId = env.YOUTUBE_CLIENT_ID;
    const clientSecret = env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(`${this.credentialsFile} needs YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.`);
    }
    const scopes = env.YOUTUBE_SCOPES ? env.YOUTUBE_SCOPES.split(",").map((s) => s.trim()) : DEFAULT_SCOPES;
    return { clientId, clientSecret, scopes };
  }

  saveToken(token: TokenSet): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.tokenFile, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.tokenFile, 0o600);
  }

  token(): TokenSet {
    if (!existsSync(this.tokenFile)) {
      throw new Error(`Profile "${this.name}" is not signed in. Run: youtube-content auth --profile ${this.name}`);
    }
    return JSON.parse(readFileSync(this.tokenFile, "utf8")) as TokenSet;
  }

  /** A valid access token, refreshed and saved when it is within five minutes of expiry. */
  async accessToken(f: typeof fetch = fetch): Promise<string> {
    const stored = this.token();
    if (!needsRefresh(stored)) return stored.accessToken;
    const { clientId, clientSecret } = this.credentials();
    try {
      const fresh = await refreshAccessToken({ clientId, clientSecret, refreshToken: stored.refreshToken, fetch: f });
      this.saveToken(fresh);
      return fresh.accessToken;
    } catch (err) {
      // Google revokes refresh tokens of OAuth apps left in "Testing" after 7 days.
      if (err instanceof Error && /invalid_grant/.test(err.message)) {
        throw new Error(`The sign-in for profile "${this.name}" expired. Run: youtube-content auth --profile ${this.name}`);
      }
      throw err;
    }
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
  return new Profile(argvProfile ?? process.env.YOUTUBE_PROFILE ?? "default");
}
