/**
 * ReporterTicketDetailPage.tsx - Reporter view of a single ticket.
 *
 * Thin wrapper around TicketDetailView with canEdit=false and showAudit=false,
 * so reporters can read their ticket details and add comments, but cannot
 * change status or view internal audit trails.
 */
import { useParams } from "react-router-dom";
import type { UserInfo } from "../types/auth";
import Layout from "../components/Layout";
import TicketDetailView from "../components/TicketDetailView";

type ReporterTicketDetailPageProps = {
  user: UserInfo;
  role: "reporter";
  onLogout: () => void;
};

export default function ReporterTicketDetailPage({
  user,
  role,
  onLogout,
}: ReporterTicketDetailPageProps) {
  const { id } = useParams();

  if (!id) {
    return (
      <Layout user={user} role={role} onLogout={onLogout}>
        <div className="p-8 text-sm text-red-700">Missing ticket id.</div>
      </Layout>
    );
  }

  const content = (
    <TicketDetailView
      ticketId={id}
      user={user}
      backPath="/my-tickets"
      canEdit={false}
      showAudit={false}
    />
  );

  return (
    <Layout user={user} role={role} onLogout={onLogout}>
      {content}
    </Layout>
  );
}
