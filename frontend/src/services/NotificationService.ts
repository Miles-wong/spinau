import { callBackendAPI } from "./AuthService";

export type AppNotification = {
  id: string;
  type?: string;
  ticket_id?: string;
  actor_email?: string;
  title?: string;
  body?: string;
  created_at?: unknown;
  read_at?: unknown;
  channels?: string[];
  delivery_status?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

export function subscribeUserNotifications(
  email: string,
  onChange: (notifications: AppNotification[]) => void,
  onError?: (error: unknown) => void
): () => void {
  if (!email) {
    onChange([]);
    return () => {};
  }

  let stopped = false;
  let loading = false;

  const load = async () => {
    if (stopped || loading) return;
    loading = true;
    try {
      const result = await callBackendAPI<{ notifications: AppNotification[] }>(
        "/api/notifications?limit=20",
        "GET"
      );
      if (stopped) return;
      onChange(result.notifications || []);
    } catch (error) {
      if (stopped) return;
      onChange([]);
      onError?.(error);
    } finally {
      loading = false;
    }
  };

  void load();
  const timer = window.setInterval(() => void load(), 30_000);

  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

export async function markNotificationRead(email: string, notificationId: string): Promise<void> {
  if (!email || !notificationId) return;

  await callBackendAPI("/api/notifications/mark-read", "POST", {
    notification_ids: [notificationId],
  });
}

export async function markNotificationsRead(email: string, notifications: AppNotification[]): Promise<void> {
  if (!email) return;

  await callBackendAPI("/api/notifications/mark-read", "POST", {});
}

export async function notifyTicketEvent(params: {
  eventType: string;
  ticketId: string;
  metadata?: Record<string, unknown>;
}): Promise<{ created: number; notification_ids: string[] }> {
  return callBackendAPI("/api/notifications/ticket-event", "POST", {
    event_type: params.eventType,
    ticket_id: params.ticketId,
    metadata: params.metadata || {},
  });
}
