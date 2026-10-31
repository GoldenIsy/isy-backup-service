const CREDENTIAL_FIELD = /\b(password|passwd|secret|token|authorization|credential|access[_-]?key)\b\s*[:=]\s*([^\s,;]+)/giu;
const URL_CREDENTIAL = /(https?:\/\/[^\s/:@]+:)[^\s/@]+@/giu;

export function createRedactor(secretValues: readonly string[] = []): (value: string) => string {
  const secrets = [...new Set(secretValues.filter((value) => value.length >= 3))].sort((a, b) => b.length - a.length);
  return (input: string): string => {
    let output = input;
    for (const secret of secrets) output = output.replaceAll(secret, '[REDACTED]');
    return output
      .replace(URL_CREDENTIAL, '$1[REDACTED]@')
      .replace(CREDENTIAL_FIELD, '$1=[REDACTED]')
      .slice(0, 4096);
  };
}

export function credentialValuesFromText(value: string): string[] {
  const result = [value];
  for (const line of value.split(/\r?\n/gu)) {
    const match = /^\s*(?:password|passwd|secret|token|authorization|credential|access[_-]?key|secret[_-]?access[_-]?key)\s*=\s*(.+?)\s*$/iu.exec(line);
    if (match?.[1]) result.push(match[1]);
  }
  return result;
}
