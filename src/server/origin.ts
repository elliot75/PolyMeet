const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

function parseHost(host: string | undefined, protocol = 'http'): URL | undefined {
  if (!host || /[\s/\\%?#@]/.test(host)) return;
  try {
    const target = new URL(`${protocol}://${host}`);
    const defaultPort = protocol === 'https' ? '443' : '80';
    if (
      host.toLowerCase() === target.host ||
      host.toLowerCase() === `${target.hostname}:${defaultPort}`
    )
      return target;
  } catch {
    return;
  }
}

export function isAllowedOrigin(host: string | undefined, origin: string | undefined): boolean {
  const target = parseHost(host);
  if (!target) return false;
  if (loopbackHosts.includes(target.hostname)) {
    return (
      origin === undefined ||
      origin === target.origin ||
      origin === 'http://127.0.0.1:5173' ||
      origin === 'http://localhost:5173'
    );
  }
  const remote = parseHost(host, 'https');
  return (
    !!remote &&
    (origin === undefined || origin === remote.origin) &&
    (process.env.POLYMEET_HTTPS_ORIGINS ?? '')
      .split(',')
      .some((entry) => entry.trim() === remote.origin)
  );
}

export function isLocalRequest(host: string | undefined, forwardedHost: string | undefined) {
  const target = parseHost(host);
  return forwardedHost === undefined && !!target && loopbackHosts.includes(target.hostname);
}
