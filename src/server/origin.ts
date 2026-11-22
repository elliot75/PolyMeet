/** Limit the local proxy to loopback hostnames and the application origin. */
export function isAllowedOrigin(host: string | undefined, origin: string | undefined): boolean {
  if (!host) return false;
  try {
    const target = new URL(`http://${host}`);
    if (
      target.username ||
      target.password ||
      target.pathname !== '/' ||
      target.search ||
      target.hash ||
      !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    )
      return false;
    if (!origin) return true;
    const caller = new URL(origin);
    if (caller.origin !== origin || caller.protocol !== 'http:') return false;
    return (
      caller.origin === target.origin ||
      caller.origin === 'http://127.0.0.1:5173' ||
      caller.origin === 'http://localhost:5173'
    );
  } catch {
    return false;
  }
}
