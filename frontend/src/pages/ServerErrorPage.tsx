/**
 * ServerErrorPage - Display when backend is not available or misconfigured
 * 
 * This page shows clear troubleshooting steps for common issues:
 * - Backend port not listening
 * - Missing environment variables
 * - Firebase configuration errors
 */

import { useEffect, useState } from "react";
import { checkBackendHealth, formatHealthErrorMessage, type HealthCheckResult } from "../services/HealthService";

interface ServerErrorPageProps {
  onRetry?: () => void;
}

export default function ServerErrorPage({ onRetry }: ServerErrorPageProps) {
  const [healthResult, setHealthResult] = useState<HealthCheckResult | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    const checkHealth = async () => {
      const result = await checkBackendHealth();
      setHealthResult(result);
    };

    checkHealth();
  }, []);

  const handleRetry = async () => {
    setIsRetrying(true);
    const result = await checkBackendHealth();
    setHealthResult(result);
    setIsRetrying(false);

    if (result.healthy && onRetry) {
      onRetry();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-4">⚠️</div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Backend is Not Available
          </h1>
          <p className="text-gray-600">
            The application server is not responding. Please follow the steps below.
          </p>
        </div>

        {/* Error Message */}
        {healthResult && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-8 rounded">
            <p className="text-red-800 font-mono text-sm whitespace-pre-wrap">
              {formatHealthErrorMessage(healthResult)}
            </p>
            
            {/* Show actual config errors if available */}
            {healthResult.status?.config?.errors && healthResult.status.config.errors.length > 0 && (
              <div className="mt-4 pt-4 border-t border-red-300">
                <p className="font-semibold text-red-900 mb-2">Configuration Errors:</p>
                <ul className="space-y-1">
                  {healthResult.status.config.errors.map((err, i) => (
                    <li key={i} className="text-red-700 text-sm">• {err}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Troubleshooting Steps */}
        <div className="bg-blue-50 rounded-lg p-6 mb-8">
          <h2 className="text-lg font-semibold text-blue-900 mb-4">
            Troubleshooting Steps
          </h2>

          <ol className="space-y-4">
            <li className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center font-semibold">
                1
              </div>
              <div>
                <p className="font-semibold text-blue-900">Start the Flask Backend</p>
                <p className="text-blue-700 text-sm mt-1">
                  Open a terminal in the <code className="bg-white px-2 py-1 rounded">backend/</code> folder and run:
                </p>
                <code className="block bg-white p-3 rounded mt-2 text-xs border border-blue-200 overflow-x-auto">
                  python app.py
                </code>
              </div>
            </li>

            <li className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center font-semibold">
                2
              </div>
              <div>
                <p className="font-semibold text-blue-900">Check Configuration Files</p>
                <p className="text-blue-700 text-sm mt-1">
                  Make sure these files exist in the <code className="bg-white px-2 py-1 rounded">backend/</code> folder:
                </p>
                <ul className="list-disc list-inside text-blue-700 text-sm mt-2 space-y-1">
                  <li><code className="bg-white px-2 py-1 rounded">.env</code> with required variables</li>
                  <li><code className="bg-white px-2 py-1 rounded">serviceAccountKey.json</code> (Firebase key)</li>
                </ul>
              </div>
            </li>

            <li className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center font-semibold">
                3
              </div>
              <div>
                <p className="font-semibold text-blue-900">Check Environment Variables</p>
                <p className="text-blue-700 text-sm mt-1">
                  Verify your <code className="bg-white px-2 py-1 rounded">.env</code> file includes:
                </p>
                <code className="block bg-white p-3 rounded mt-2 text-xs border border-blue-200 space-y-1">
                  FIREBASE_SERVICE_ACCOUNT=serviceAccountKey.json
                  <br />
                  OPENAI_API_KEY=your_key_here
                  <br />
                  FIREBASE_PROJECT_ID=your_project_id
                </code>
              </div>
            </li>

            <li className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center font-semibold">
                4
              </div>
              <div>
                <p className="font-semibold text-blue-900">View Backend Logs</p>
                <p className="text-blue-700 text-sm mt-1">
                  Check the terminal where Flask is running for detailed error messages.
                </p>
              </div>
            </li>
          </ol>
        </div>

        {/* Retry Button */}
        <button
          onClick={handleRetry}
          disabled={isRetrying}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-3 px-4 rounded-lg transition"
        >
          {isRetrying ? "Checking..." : "Retry Connection"}
        </button>

        {/* Footer */}
        <p className="text-center text-gray-600 text-sm mt-6">
          The Flask server should be running on{" "}
          <code className="bg-gray-100 px-2 py-1 rounded">http://localhost:5000</code>
        </p>
      </div>
    </div>
  );
}
