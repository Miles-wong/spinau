import { getAuthToken } from "./AuthService";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

function getFilenameFromContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;

  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const quotedMatch = header.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1];

  const plainMatch = header.match(/filename=([^;]+)/i);
  if (plainMatch?.[1]) return plainMatch[1].trim();

  return fallback;
}

export async function downloadFullAdminTicketsExport(options?: {
  includeInternal?: boolean;
}): Promise<{ blob: Blob; filename: string }> {
  const token = await getAuthToken();
  const includeInternal = options?.includeInternal ?? true;

  const endpoint = `${API_BASE_URL}/api/admin/exports/tickets.csv?include_internal=${includeInternal ? "1" : "0"}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Full admin export failed: ${response.status}`);
  }

  const blob = await response.blob();
  const filename = getFilenameFromContentDisposition(
    response.headers.get("Content-Disposition"),
    "admin-full-tickets.csv"
  );

  return { blob, filename };
}

export function saveBlobToFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
