# ads-kit

Typed, quirk-aware ad-platform API clients for TypeScript. One package per
platform — campaign structures, error semantics, and release cadences differ
too much for a unified abstraction, so each client is honest about its
platform instead.

| Package | Platform | Status |
|---|---|---|
| [`tiktok-ads-kit`](./packages/tiktok-ads-kit) | TikTok Marketing API | published |
| `meta-ads-kit` | Meta Marketing API | in progress |

Shared conventions across packages: factory config (`createXAds({...})`),
errors thrown with the platform's real message, writes never cached,
destructive defaults off (entities created paused).

Related: [`next-pixels`](https://github.com/oliver-virt/next-pixels) — the
other direction: events from your site into the platforms (pixel + CAPI +
first-touch attribution).

## License

MIT
