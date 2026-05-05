/**
 * Layout.tsx - Shared application shell used by all authenticated pages.
 *
 * Renders the top navigation bar with:
 * - Role-sensitive menu items (admin vs reporter).
 * - Durable notification badges backed by users/{uid}/notifications.
 * - Logout button.
 */
import { useNavigate, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import type { UserInfo, UserRole } from "../types/auth";
import { warmupConversation } from "../services/ConversationWarmupService";
import {
  markNotificationRead,
  markNotificationsRead,
  subscribeUserNotifications,
  type AppNotification,
} from "../services/NotificationService";
import "./Layout.css";

type LayoutProps = {
  user: UserInfo;
  role: UserRole;
  onLogout: () => void;
  children: React.ReactNode;
};

type MenuItem = {
  label: string;
  path: string;
};

function timestampToMillis(input: unknown): number {
  if (typeof input === "number") return input;
  if (typeof input === "string") return Date.parse(input);
  if (input && typeof input === "object" && "toMillis" in input) {
    return (input as { toMillis: () => number }).toMillis();
  }
  return 0;
}

function toRelativeTimeLabel(input: unknown): string {
  const timestamp = timestampToMillis(input);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Just now";

  const diffMs = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "Just now";
  if (diffMs < hour) {
    const m = Math.floor(diffMs / minute);
    return `${m} minute${m > 1 ? "s" : ""} ago`;
  }
  if (diffMs < day) {
    const h = Math.floor(diffMs / hour);
    return `${h} hour${h > 1 ? "s" : ""} ago`;
  }
  const d = Math.floor(diffMs / day);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

function toNotificationMessage(notification: AppNotification): string {
  return String(notification.body || notification.title || "Ticket notification");
}

export default function Layout({ user, role, onLogout, children }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [recentNotifications, setRecentNotifications] = useState<AppNotification[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState<AppNotification[]>([]);
  const [notificationMenuPath, setNotificationMenuPath] = useState<string | null>(null);

  useEffect(() => {
    if (!user.uid) {
      setRecentNotifications([]);
      setUnreadNotifications([]);
      return;
    }

    const unsubscribe = subscribeUserNotifications(
      user.uid,
      (items) => {
        setRecentNotifications(items);
        setUnreadNotifications(items.filter((item) => !item.read_at));
      }
    );

    return unsubscribe;
  }, [user.uid]);

  const showNotificationMenu = notificationMenuPath === location.pathname;
  const visibleUnreadCount = unreadNotifications.length;

  const getMenuItems = (): MenuItem[] => {
    if (role === "admin") {
      return [
        { label: "Dashboard",       path: "/admin/dashboard" },
        { label: "New Report", path: "/report-chat" },
        { label: "Tickets",         path: "/admin/tickets" },
        { label: "Audit",           path: "/admin/audit" },
      ];
    } else if (role === "reporter") {
      return [
        { label: "New Report", path: "/report-chat" },
        { label: "My Tickets",      path: "/my-tickets" },
      ];
    }
    return [];
  };

  const menuItems = getMenuItems();
  const isActive = (path: string) => location.pathname === path;

  const warmupNewReport = () => {
    void warmupConversation().catch(() => {
      // The report page owns user-facing retry/error handling.
    });
  };

  const navigateMenuItem = (path: string) => {
    if (path === "/report-chat") {
      warmupNewReport();
    }
    navigate(path);
  };

  const navigateNotification = (notification: AppNotification | null) => {
    if (!notification?.id) {
      navigate(role === "admin" ? "/admin/tickets" : "/my-tickets");
      return;
    }

    void markNotificationRead(user.uid, notification.id).catch(() => {
      // Reading state is useful, but navigation should not be blocked by it.
    });

    const ticketId = String(notification.ticket_id || "");
    if (!ticketId) {
      navigate(role === "admin" ? "/admin/tickets" : "/my-tickets");
      return;
    }

    navigate(role === "admin" ? `/admin/tickets/${ticketId}` : `/tickets/${ticketId}`, {
      state: {
        fromNotification: true,
        updateHint: notification.body || notification.title || "",
      },
    });
  };

  const markVisibleNotificationsRead = () => {
    void markNotificationsRead(user.uid, recentNotifications)
      .then(() => {
        const readAt = new Date().toISOString();
        setRecentNotifications((items) => items.map((item) => ({ ...item, read_at: item.read_at || readAt })));
        setUnreadNotifications([]);
      })
      .catch((error) => {
        console.warn("Failed to mark notifications read:", error);
      });
  };

  return (
    <div className="layout-shell">
      <nav className="top-nav">
        <div className="top-nav-inner">
          <div className="brand">SPIN x CYBER</div>

          <div className="menu-group">
            {menuItems.map((item) => (
              <button
                key={item.path}
                onMouseEnter={item.path === "/report-chat" ? warmupNewReport : undefined}
                onFocus={item.path === "/report-chat" ? warmupNewReport : undefined}
                onClick={() => navigateMenuItem(item.path)}
                className={`menu-item ${isActive(item.path) ? "active" : ""}`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="right-group">
            <div className="reply-wrap">
              <button
                onClick={() => {
                  setNotificationMenuPath((prev) => (prev === location.pathname ? null : location.pathname));
                }}
                className="notify-btn"
                title="Notifications"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="icon"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14.857 17.082a23.848 23.848 0 0 1 5.454 1.31A8.967 8.967 0 0 1 18 9.75v-.7V9a6 6 0 1 0-12 0v.05c0 .228 0 .456 0 .7a8.967 8.967 0 0 1-2.311 8.642 23.848 23.848 0 0 1 5.454-1.31m5.714 0a24.255 24.255 0 0 0-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
                  />
                </svg>
                {visibleUnreadCount > 0 && (
                  <span className="notify-count">{visibleUnreadCount > 99 ? "99+" : visibleUnreadCount}</span>
                )}
              </button>

              {showNotificationMenu && (
                <div className="reply-menu">
                  <div className="reply-menu-title">Recent Notifications</div>
                  <div className="reply-list">
                    {recentNotifications.length === 0 && (
                      <div className="reply-empty">No recent updates yet.</div>
                    )}
                    {recentNotifications.map((notification) => (
                      <button
                        key={notification.id}
                        onClick={() => {
                          setNotificationMenuPath(null);
                          navigateNotification(notification);
                        }}
                        className={`reply-item ${notification.read_at ? "" : "unread"}`}
                      >
                        <div className="reply-text">{toNotificationMessage(notification)}</div>
                        <div className="reply-time">{toRelativeTimeLabel(notification.created_at)}</div>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={markVisibleNotificationsRead}
                    className="reply-open-btn"
                    disabled={visibleUnreadCount === 0}
                  >
                    Mark All Read
                  </button>
                </div>
              )}
            </div>

            <div className="user-block">
              <div className="user-name">{user.name || user.email || "User"}</div>
              <div className="user-role">{role}</div>
            </div>

            <button onClick={onLogout} className="logout-btn">Logout</button>
          </div>
        </div>
      </nav>

      <main className="page-main">{children}</main>
    </div>
  );
}
