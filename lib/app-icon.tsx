/**
 * The app icon, drawn in code so there is no image file to keep in the repo.
 *
 * Used for the browser tab, the iPhone home-screen icon (apple-icon) and the
 * web-app manifest. One function so all three are the same picture.
 *
 * Full-bleed colour with no rounded corners of its own: iOS and Android each
 * apply their own mask, and an icon that rounds itself ends up with a white
 * rim inside the system's corner.
 */
import { ImageResponse } from "next/og";

export function renderAppIcon(size: number): ImageResponse {
  const bar = (heightPct: number, opacity: number) => (
    <div
      style={{
        width: size * 0.13,
        height: size * heightPct,
        background: "#ffffff",
        opacity,
        borderRadius: size * 0.03,
      }}
    />
  );
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #4f46e5 0%, #4338ca 100%)",
        }}
      >
        {/* three rising bars — the scorecard's own mark */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: size * 0.055, height: size * 0.36 }}>
          {bar(0.16, 0.7)}
          {bar(0.26, 0.85)}
          {bar(0.36, 1)}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: size * 0.05,
            color: "#ffffff",
            fontSize: size * 0.2,
            fontWeight: 700,
            letterSpacing: size * 0.012,
          }}
        >
          QAV
        </div>
      </div>
    ),
    { width: size, height: size },
  );
}
