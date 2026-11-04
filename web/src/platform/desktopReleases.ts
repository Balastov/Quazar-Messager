export type DesktopReleaseOS = "windows" | "mac";
export interface DesktopInstaller { name: string; url: string }
export interface PublishedDesktopRelease { version: string; installers: DesktopInstaller[] }
export const DESKTOP_RELEASE_POLL_INTERVAL = 5 * 60_000;

// Read only the version from the updater feed. Download URLs always use our fixed origin/path.
export function desktopFeedVersion(feed: string): string | null {
  if (feed.length > 64_000) return null;
  const matches = [...feed.matchAll(/^version: *["']?(\d+\.\d+\.\d+)["']? *\r?$/gm)];
  return matches.length === 1 ? matches[0][1] : null;
}

export async function publishedDesktopRelease(os: DesktopReleaseOS, signal: AbortSignal): Promise<PublishedDesktopRelease | null> {
  const channels = os === "windows" ? ["win-x64"] : ["mac-arm64", "mac-x64"];
  const versions = await Promise.all(channels.map(async channel => {
    const name = channel === "win-x64" ? "latest.yml" : "latest-mac.yml";
    const response = await fetch(`/desktop-updates/${channel}/${name}`, { signal, cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error("Desktop feed unavailable");
    return desktopFeedVersion(await response.text());
  }));
  const version = versions[0];
  // Wait until both Mac channels have been published before offering either architecture.
  if (!version || versions.some(value => value !== version)) return null;
  const names: Record<string, string> = { "win-x64": "Windows x64", "mac-arm64": "Mac с чипом Apple (M1 и новее)", "mac-x64": "Mac с процессором Intel" };
  return { version, installers: channels.map(channel => ({ name: names[channel],
    url: `/desktop-updates/${channel}/Quazar-${version}-${channel}.${channel === "win-x64" ? "exe" : "dmg"}` })) };
}
