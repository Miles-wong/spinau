/**
 * HealthService - Check backend health status
 * 
 * Used to detect if backend is running and properly configured
 * before attempting to make other API calls.
 */

const HEALTH_CHECK_TIMEOUT = 5000; // 5 seconds
const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

export interface HealthStatus {
  status: "ok" | "warning" | "error";
  message: string;
  backend: {
    running: boolean;
    port: number;
  };
  firebase?: {
    initialized: boolean;
    project_id?: string;
    error?: string;
  };
  ai_provider?: {
    configured: boolean;
    provider: "openai" | "none";
  };
  config?: {
    warnings: string[];
    errors: string[];
  };
}

export interface HealthCheckResult {
  healthy: boolean;
  status?: HealthStatus;
  error?: string;
}

/**
 * Check if backend is healthy and properly configured.
 * 
 * Returns detailed status information or connection error.
 */
export async function checkBackendHealth(): Promise<HealthCheckResult> {
  try {
    const healthUrl = `${API_BASE_URL}/api/health`;
    console.log("[HealthService] Checking backend health at", healthUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

    const response = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    console.log("[HealthService] Response status:", response.status);

    if (!response.ok) {
      return {
        healthy: false,
        error: `Health check returned ${response.status}: ${response.statusText}`,
      };
    }

    const status: HealthStatus = await response.json();
    // Only consider it "unhealthy" if there are actual errors, not just warnings
    const healthy = status.status !== "error";

    console.log("[HealthService] Backend healthy:", healthy, "Status:", status.status);

    return {
      healthy,
      status,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    console.error("[HealthService] Fetch error:", error, err);

    // Distinguish between connection error and timeout
    if (error.includes("abort")) {
      return {
        healthy: false,
        error: `Backend is not responding (timeout after ${HEALTH_CHECK_TIMEOUT}ms). Is Flask running on port 5000?`,
      };
    }

    if (error.includes("Failed to fetch") || error.includes("ERR_CONNECTION_REFUSED")) {
      return {
        healthy: false,
        error: `Backend is not running. Please start Flask: python app.py`,
      };
    }

    return {
      healthy: false,
      error: `Failed to check backend health: ${error}`,
    };
  }
}

/**
 * Format error message for user display based on health check result.
 */
export function formatHealthErrorMessage(result: HealthCheckResult): string {
  if (result.status?.config?.errors && result.status.config.errors.length > 0) {
    const errors = result.status.config.errors.map(e => `  • ${e}`).join("\n");
    return `Backend configuration error:\n${errors}\n\nPlease check your .env file and serviceAccountKey.json`;
  }

  if (result.status?.firebase?.error) {
    return `Firebase initialization failed:\n  ${result.status.firebase.error}\n\nPlease verify your Firebase configuration.`;
  }

  return result.error || "Backend is not available. Please try again later.";
}
