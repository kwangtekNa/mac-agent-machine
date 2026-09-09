const PLACEHOLDER_RE = /__([A-Z][A-Z0-9_]*)__/g;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * `__NAME__` 자리표시자를 XML 이스케이프한 값으로 치환한다.
 * 값이 없는 자리표시자가 남으면 실패한다(잘못된 plist 를 설치하지 않기 위해).
 */
export function renderPlist(template: string, vars: Record<string, string>): string {
  const missing = new Set<string>();
  const out = template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      missing.add(whole);
      return whole;
    }
    return escapeXml(v);
  });
  if (missing.size > 0) throw new Error(`plist 템플릿에 값이 없는 자리표시자: ${[...missing].join(", ")}`);
  return out;
}
