export function redactSecrets(value, secret) {
  return (
    secret === undefined || secret === '' ? value : value.replaceAll(secret, '[REDACTED]')
  ).replaceAll(/Bearer\s+[^\s]+/giu, 'Bearer [REDACTED]');
}
