// Browser-tab icon. See lib/app-icon.tsx.
import { renderAppIcon } from "@/lib/app-icon";

export const runtime = "edge";
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return renderAppIcon(64);
}
