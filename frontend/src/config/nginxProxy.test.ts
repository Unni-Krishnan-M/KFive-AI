import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('production reverse proxy service discovery', () => {
  it('re-resolves the backend after its container address changes', () => {
    const config = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
    expect(config).toContain('resolver 127.0.0.11');
    expect(config).toContain('set $backend_upstream backend:5000;');
    expect(config.match(/proxy_pass http:\/\/\$backend_upstream;/g)).toHaveLength(2);
    expect(config).not.toContain('proxy_pass http://backend:5000;');
  });

  it('permits the documented upload size and the bounded OCR response window', () => {
    const config = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
    expect(config).toContain('client_max_body_size 52m;');
    expect(config).toContain('proxy_read_timeout 95s;');
    expect(config).toContain('proxy_send_timeout 95s;');
  });

  it('does not buffer API event streams needed for live Agent cancellation', () => {
    const config = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
    const apiLocation = config.match(/location \/api\/ \{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
    expect(apiLocation).toContain('proxy_buffering off;');
  });

  it('preserves the outer TLS proxy chain for client IP and HTTPS detection', () => {
    const config = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
    expect(config.match(/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/g)).toHaveLength(2);
    expect(config.match(/proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;/g)).toHaveLength(2);
    expect(config).not.toContain('proxy_set_header X-Forwarded-Proto $scheme;');
  });
});
