const secretKeys = /^(authorization|cookie|password|passwd|token|apikey|api_key|secret|credential|privatekey)$/i;

export function redact(value: unknown, extraSecrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of extraSecrets) {
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/(https?:\/\/[^\s"<>]*[?&](?:token|api_key|key|password|secret)=)[^&\s"<>]*/gi, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, extraSecrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, secretKeys.test(key) ? '[redacted]' : redact(val, extraSecrets)]),
    );
  }
  return value;
}
