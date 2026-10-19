/** Phone frame around the real app, to preview the mobile prototype from a desktop browser (PROTOTYPE.md). */
export default function MobileFramePage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[radial-gradient(1200px_600px_at_50%_-10%,var(--sea-soft),transparent_60%)] p-6">
      <div className="relative flex h-[820px] max-h-[calc(100dvh-48px)] w-[390px] flex-col overflow-hidden rounded-[48px] border-[10px] border-[#0A141C] bg-panel shadow-2xl">
        <iframe src="/hoy" title="Meri" className="h-full w-full border-0" />
      </div>
    </main>
  );
}
