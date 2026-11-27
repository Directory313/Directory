// Directory logo: the "D" mark with a play-triangle cut-out (source: assets/brand/directory-mark.svg).
export const MARK_PATH = 'M0,0 H166 A148,146.5 0 0 1 166,293 H93 V231.8 L0,285 Z M88,63 L241,147 L88,234.7 Z';

export function Logo({ size = 22, word = false }: { size?: number; word?: boolean }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <svg width={size} height={size} viewBox="-4 -14 322 322" aria-label="Directory">
        <path d={MARK_PATH} fill="currentColor" fillRule="evenodd" />
      </svg>
      {word && <span style={{ fontWeight: 600, letterSpacing: '0.08em', fontSize: size * 0.62 }}>Directory</span>}
    </span>
  );
}
