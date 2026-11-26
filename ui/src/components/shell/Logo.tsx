export function Logo({ size = 22, word = false }: { size?: number; word?: boolean }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <svg width={size} height={size} viewBox="0 0 64 64" aria-label="VEYRA">
        <rect width="64" height="64" rx="14" fill="#101010" stroke="#2a2a2a" />
        <path d="M18.5 20 L32 46 L45.5 20" fill="none" stroke="#F28D96" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="32" cy="14.5" r="3.4" fill="#FFC0C5" />
      </svg>
      {word && <span style={{ fontWeight: 700, letterSpacing: '0.32em', fontSize: size * 0.55 }}>VEYRA</span>}
    </span>
  );
}
