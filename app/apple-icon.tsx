// The iPhone / iPad home-screen icon ("Add to Home Screen"). iOS wants a PNG
// at 180x180 and ignores SVG here. See lib/app-icon.tsx.
import { renderAppIcon } from "@/lib/app-icon";

export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return renderAppIcon(180);
}
