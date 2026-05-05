/**
 * AdminTicketDetailPage.tsx - Admin view of a single ticket.
 *
 * Thin wrapper around TicketDetailView with canEdit=true and showAudit=true,
 * giving admins full editing capabilities and access to the audit log tab.
 */
import { useParams } from "react-router-dom";
import type { UserInfo } from "../types/auth";
import Layout from "../components/Layout";
import TicketDetailView from "../components/TicketDetailView";

type AdminTicketDetailPageProps = {
  user: UserInfo;
  role: "admin";
  onLogout: () => void;
};

export default function AdminTicketDetailPage({
  user,
  role,
  onLogout,
}: AdminTicketDetailPageProps) {
  const { id } = useParams();

  if (!id) {
    return (
      <Layout user={user} role={role} onLogout={onLogout}>
        <div className="p-8 text-sm text-red-700">Missing ticket id.</div>
      </Layout>
    );
  }

  const content = <TicketDetailView ticketId={id} user={user} backPath="/admin/tickets" canEdit showAudit />;

  return (
    <Layout user={user} role={role} onLogout={onLogout}>
      {content}
    </Layout>
  );
}
