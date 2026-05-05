/**
 * AISuggestionsCard.tsx - Display AI-inferred classification and severity
 * 
 * Separates AI suggestions from user input, showing confidence and reasoning concisely.
 */

interface AISuggestionsCardProps {
  classification?: string;
  severity?: string;
  category?: string;
  confidence?: number; // 0-100
  showDetails?: boolean;
  onDismiss?: () => void;
}

export default function AISuggestionsCard({
  classification,
  severity,
  category,
  confidence = 75,
  showDetails = false,
  onDismiss,
}: AISuggestionsCardProps) {
  // Hide card if no suggestions
  if (!classification && !severity && !category) {
    return null;
  }

  const fmt = (value: string) =>
    value
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

  const getSeverityColor = (sev: string) => {
    switch (sev?.toLowerCase()) {
      case "critical":
        return "bg-red-100 border-red-300 text-red-900";
      case "high":
        return "bg-orange-100 border-orange-300 text-orange-900";
      case "medium":
        return "bg-yellow-100 border-yellow-300 text-yellow-900";
      case "low":
        return "bg-blue-100 border-blue-300 text-blue-900";
      default:
        return "bg-gray-100 border-gray-300 text-gray-900";
    }
  };

  return (
    <div className="rounded-lg border-2 border-blue-200 bg-blue-50 p-4 mb-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-blue-900">🤖 AI Analysis</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            {confidence}% confidence
          </span>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-blue-400 hover:text-blue-600 text-lg leading-none"
          >
            ×
          </button>
        )}
      </div>

      {/* Quick Summary Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        {severity && (
          <div className={`rounded px-3 py-2 border ${getSeverityColor(severity)}`}>
            <div className="text-xs font-semibold opacity-75">Severity</div>
            <div className="text-sm font-bold mt-0.5">{fmt(severity)}</div>
          </div>
        )}

        {category && (
          <div className="rounded px-3 py-2 border bg-purple-100 border-purple-300 text-purple-900">
            <div className="text-xs font-semibold opacity-75">Category</div>
            <div className="text-sm font-bold mt-0.5">{fmt(category)}</div>
          </div>
        )}

        {classification && (
          <div className="rounded px-3 py-2 border bg-teal-100 border-teal-300 text-teal-900">
            <div className="text-xs font-semibold opacity-75">Classification</div>
            <div className="text-sm font-bold mt-0.5">{fmt(classification)}</div>
          </div>
        )}
      </div>

      {/* Reasoning (Collapsible) */}
      {showDetails && (
        <div className="mt-3 pt-3 border-t border-blue-200 text-xs text-blue-700">
          <p className="text-xs font-semibold mb-1">Reasoning:</p>
          <p className="opacity-75">
            Based on incident description, this appears to be a{" "}
            <span className="font-semibold">{fmt(category || "")}</span> incident of{" "}
            <span className="font-semibold">{fmt(severity || "")}</span> severity. Consider reviewing for accuracy before
            finalizing the classification.
          </p>
        </div>
      )}

      {/* Footer Note */}
      <div className="mt-2 text-xs text-blue-600 italic">
        💡 Verify and adjust classifications as needed. User input takes precedence.
      </div>
    </div>
  );
}
