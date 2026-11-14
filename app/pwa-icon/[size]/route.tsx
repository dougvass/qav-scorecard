// Icons for the web-app manifest (app/manifest.ts): /pwa-icon/192 and
// /pwa-icon/512. Any other size is refused rather than rendered on demand.
import { renderAppIcon } from "@/lib/app-icon";

export const runtime = "edge";

const SIZES = [192, 512];

export function GET(_request: Request, { params }: { params: { size: string } }) {
  const size = Number(params.size);
  if (SIZES.indexOf(size) < 0) return new Response("Not found", { status: 404 });
  return renderAppIcon(size);
}
