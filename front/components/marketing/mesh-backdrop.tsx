// Decorative absolute-positioned radial-gradient mesh for bold heroes.
// Pointer-events-none so it never blocks clicks; aria-hidden because purely
// visual. Two intensity variants — bright on light backdrops, deep on ink.

export function MeshBackdrop({
  tone = "bright",
}: {
  tone?: "bright" | "deep";
}) {
  if (tone === "deep") {
    return (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div
          className="absolute -left-32 -top-32 h-[520px] w-[520px] rounded-full opacity-60 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, rgb(46 101 69 / 0.45) 0%, transparent 70%)",
          }}
        />
        <div
          className="absolute -right-24 top-32 h-[460px] w-[460px] rounded-full opacity-40 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, rgb(108 166 127 / 0.4) 0%, transparent 70%)",
          }}
        />
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div
        className="absolute -left-24 -top-24 h-[420px] w-[420px] rounded-full opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgb(46 101 69 / 0.22) 0%, transparent 72%)",
        }}
      />
      <div
        className="absolute -right-16 top-16 h-[380px] w-[380px] rounded-full opacity-35 blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgb(108 166 127 / 0.2) 0%, transparent 70%)",
        }}
      />
    </div>
  );
}
