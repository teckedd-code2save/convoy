import { isIP } from 'node:net';
import { lookup, resolve4, resolve6 } from 'node:dns/promises';

/**
 * DNS preflight for VPS + Caddy deploys (issue #35). When Convoy is about
 * to write a Caddy site file for a domain, the deploy only goes green if
 * that domain actually points at the box — otherwise Caddy can't obtain a
 * certificate and the operator gets a confusing late failure. Checked with
 * node:dns (no shelling to dig): record-exists + IP-match only, no CDN
 * detection.
 *
 * Probed ONLY when Caddy management is on — Convoy never resolves domains
 * it wasn't asked to manage.
 */

export type DnsCheckOutcome =
  | { status: 'match'; domainIps: string[]; vpsIp: string }
  | { status: 'no-record'; vpsIp: string | null }
  | { status: 'mismatch'; domainIps: string[]; vpsIp: string }
  | { status: 'unresolved-host'; reason: string };

/** Strip a `user@` prefix and optional port from an SSH destination. */
export function vpsHostname(vpsHost: string): string {
  const withoutUser = vpsHost.includes('@') ? vpsHost.slice(vpsHost.indexOf('@') + 1) : vpsHost;
  // Only strip a :port suffix when the rest isn't an IPv6 literal.
  const colonIdx = withoutUser.lastIndexOf(':');
  if (colonIdx > 0 && !withoutUser.slice(0, colonIdx).includes(':')) {
    const maybePort = withoutUser.slice(colonIdx + 1);
    if (/^\d+$/.test(maybePort)) return withoutUser.slice(0, colonIdx);
  }
  return withoutUser;
}

async function resolveDomainIps(domain: string): Promise<string[]> {
  const ips: string[] = [];
  const [a, aaaa] = await Promise.allSettled([resolve4(domain), resolve6(domain)]);
  if (a.status === 'fulfilled') ips.push(...a.value);
  if (aaaa.status === 'fulfilled') ips.push(...aaaa.value);
  return ips;
}

export async function checkDomainDns(
  domain: string,
  vpsHost: string,
  timeoutMs = 5000,
): Promise<DnsCheckOutcome> {
  const hostname = vpsHostname(vpsHost);

  const work = (async (): Promise<DnsCheckOutcome> => {
    let vpsIp: string | null = null;
    if (isIP(hostname) !== 0) {
      vpsIp = hostname;
    } else {
      try {
        vpsIp = (await lookup(hostname)).address;
      } catch (err) {
        return {
          status: 'unresolved-host',
          reason: `could not resolve VPS host ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const domainIps = await resolveDomainIps(domain);
    if (domainIps.length === 0) {
      return { status: 'no-record', vpsIp };
    }
    if (domainIps.includes(vpsIp)) {
      return { status: 'match', domainIps, vpsIp };
    }
    return { status: 'mismatch', domainIps, vpsIp };
  })();

  const timeout = new Promise<DnsCheckOutcome>((resolveOutcome) => {
    setTimeout(() => {
      resolveOutcome({ status: 'unresolved-host', reason: `DNS resolution timed out after ${timeoutMs}ms` });
    }, timeoutMs).unref?.();
  });

  return Promise.race([work, timeout]);
}
