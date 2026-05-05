/**
 * SimilarTicketsCard.tsx
 *
 * Displays RAG-retrieved similar historical tickets alongside a suggested
 * action returned from the backend.  Shown in the ReportIncidentChat
 * right-hand info panel once the reporter's description is long enough
 * for the backend to produce meaningful similarity results.
 */

export interface SimilarTicket {
  ticket_id?: string;
  doc_id?: string;
  title?: string;
  category?: string;
  issue_type?: string;
  severity?: string;
  status?: string;
  description?: string;
  resolution?: string;
  closure_summary?: string;
  score?: number;
}

interface SimilarTicketsCardProps {
  tickets: SimilarTicket[];
  suggestedAction?: string;
  /** Called when the user dismisses the card. */
  onDismiss?: () => void;
}

const fmt = (v: unknown) =>
  String(v ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "—";

function SeverityBadge({ value }: { value?: string }) {
  const map: Record<string, string> = {
    critical: "bg-red-100 text-red-700 border-red-200",
    high:     "bg-orange-100 text-orange-700 border-orange-200",
    medium:   "bg-yellow-100 text-yellow-700 border-yellow-200",
    low:      "bg-blue-100 text-blue-700 border-blue-200",
  };
  const key = (value ?? "").toLowerCase();
  const cls = map[key] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold ${cls}`}>
      {fmt(value)}
    </span>
  );
}

function StatusBadge({ value }: { value?: string }) {
  const map: Record<string, string> = {
    open:        "bg-blue-50 text-blue-700",
    in_progress: "bg-amber-50 text-amber-700",
    resolved:    "bg-green-50 text-green-700",
    closed:      "bg-gray-100 text-gray-500",
  };
  const key = (value ?? "").toLowerCase();
  const cls = map[key] ?? "bg-gray-100 text-gray-500";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {fmt(value)}
    </span>
  );
}

export default function SimilarTicketsCard({
  tickets,
  suggestedAction,
  onDismiss,
}: SimilarTicketsCardProps) {
  if (!tickets || tickets.length === 0) return null;

  const scorePercent = (score?: number) =>
    score != null ? `${Math.round(score * 100)}%` : null;

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 mb-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-indigo-900">🔍 Similar Past Incidents</span>
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-600">
            {tickets.length} found
          </span>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-indigo-400 hover:text-indigo-600 text-lg leading-none"
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>

      {/* Suggested action banner */}
      {suggestedAction && (
        <div className="mb-3 rounded-lg border border-indigo-200 bg-white px-3 py-2">
          <p className="text-xs font-semibold text-indigo-700 mb-0.5">💡 Suggested Action</p>
          <p className="text-xs text-gray-700 leading-relaxed">{suggestedAction}</p>
        </div>
      )}

      {/* Ticket list */}
      <div className="flex flex-col gap-2">
        {tickets.map((t, i) => {
          const id = t.ticket_id || t.doc_id || `#${i + 1}`;
          const resolution = t.resolution || t.closure_summary;
          const pct = scorePercent(t.score);

          return (
            <div
              key={id}
              className="rounded-lg border border-indigo-100 bg-white px-3 py-2.5"
            >
              {/* Top row: ID, category/severity, score */}
              <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                <span className="text-xs font-mono font-bold text-indigo-800">{id}</span>
                {t.severity && <SeverityBadge value={t.severity} />}
                {t.status && <StatusBadge value={t.status} />}
                {pct && (
                  <span className="ml-auto text-xs text-gray-400 font-medium">
                    {pct} match
                  </span>
                )}
              </div>

              {/* Title or category */}
              {(t.title || t.category) && (
                <p className="text-xs font-semibold text-gray-800 mb-1 truncate">
                  {t.title || fmt(t.category)}
                </p>
              )}

              {/* Description snippet */}
              {t.description && (
                <p className="text-xs text-gray-500 leading-relaxed line-clamp-2 mb-1.5">
                  {t.description}
                </p>
              )}

              {/* Resolution */}
              {resolution && (
                <div className="border-t border-indigo-50 pt-1.5 mt-1">
                  <p className="text-xs font-semibold text-green-700 mb-0.5">✓ Resolution</p>
                  <p className="text-xs text-gray-600 leading-relaxed line-clamp-3">{resolution}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-indigo-400 text-right">
        Based on your incident description
      </p>
    </div>
  );
}
