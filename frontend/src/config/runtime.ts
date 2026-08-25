const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

export const apiOrigin = trimTrailingSlash(import.meta.env.VITE_API_URL || '');
export const apiBaseUrl = `${apiOrigin}/api/v1`;

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${apiBaseUrl}${normalizedPath}`;
}

export function socketUrl(): string | undefined {
  const configured = import.meta.env.VITE_WS_URL;
  return configured ? trimTrailingSlash(configured) : undefined;
}
