export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--sea)" />
      <path
        d="M5 13c3.5-3 7-3 10.5 0s7 3 11.5 0"
        stroke="var(--on-sea)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M5 20c3.5-3 7-3 10.5 0s7 3 11.5 0"
        stroke="var(--on-sea)"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity=".55"
      />
    </svg>
  );
}
