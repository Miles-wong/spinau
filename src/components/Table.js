import React from "react";

function StatusBadge({ status }) {
  const s = status || "Not Started";

  const styleMap = {
    "Not Started": { background: "#f3f4f6", color: "#374151", border: "#d1d5db" },
    "In Progress": { background: "#dbeafe", color: "#1e40af", border: "#93c5fd" },
    "Completed": { background: "#dcfce7", color: "#166534", border: "#86efac" }
  };

  const st = styleMap[s] || styleMap["Not Started"];

  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 12px",
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 600,
        border: `1.5px solid ${st.border}`,
        background: st.background,
        color: st.color,
        whiteSpace: "nowrap"
      }}
      title={s}
    >
      {s}
    </span>
  );
}

export default function Table({ tasks, onDoubleClickRow, onEdit, onDelete }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "14px"
        }}
      >
        <thead>
          <tr style={{ 
            background: "#f8fafc", 
            borderBottom: "2px solid #e2e8f0",
            fontWeight: 600,
            color: "#1e293b"
          }}>
            <th style={{ padding: "14px 12px", textAlign: "left" }}>ID</th>
            <th style={{ padding: "14px 12px", textAlign: "left" }}>Task</th>
            <th style={{ padding: "14px 12px", textAlign: "left" }}>Project</th>
            <th style={{ padding: "14px 12px", textAlign: "left" }}>Status</th>
            <th style={{ padding: "14px 12px", textAlign: "left" }}>Date Range</th>
            <th style={{ padding: "14px 12px", textAlign: "center" }}># Workloads</th>
            <th style={{ padding: "14px 12px", textAlign: "center" }}>Actions</th>
          </tr>
        </thead>

        <tbody>
          {tasks.length === 0 ? (
            <tr>
              <td colSpan="7" style={{ textAlign: "center", padding: "32px 18px", borderBottom: "1px solid #e2e8f0" }}>
                <div style={{ fontSize: "16px", fontWeight: 600, color: "#475569" }}>No tasks yet.</div>
                <div style={{ opacity: 0.7, marginTop: 8, color: "#64748b" }}>
                  Click <b>+ Create Task</b> to get started.
                </div>
              </td>
            </tr>
          ) : (
            tasks.map((t, idx) => (
              <tr
                key={t.id}
                onDoubleClick={() => onDoubleClickRow(t)}
                style={{
                  cursor: "pointer",
                  borderBottom: "1px solid #e2e8f0",
                  background: idx % 2 === 0 ? "#ffffff" : "#f9fafb",
                  transition: "background-color 0.2s ease"
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = "#eff6ff"}
                onMouseLeave={(e) => e.currentTarget.style.background = idx % 2 === 0 ? "#ffffff" : "#f9fafb"}
              >
                <td style={{ padding: "12px", fontWeight: 600, color: "#1e40af" }}>{t.id}</td>
                <td style={{ padding: "12px" }}>
                  <div style={{ fontWeight: 600, color: "#1e293b" }}>{t.taskName}</div>
                  <div style={{ opacity: 0.7, fontSize: "12px", marginTop: 4, color: "#64748b" }}>
                    {t.description || ""}
                  </div>
                </td>
                <td style={{ padding: "12px", color: "#475569" }}>{t.project || "-"}</td>
                <td style={{ padding: "12px" }}>
                  <StatusBadge status={t.status} />
                </td>
                <td style={{ padding: "12px", color: "#475569", fontSize: "13px" }}>
                  {t.startDate} → {t.endDate}
                </td>
                <td style={{ padding: "12px", textAlign: "center", fontWeight: 600, color: "#1e40af" }}>
                  {t.workloads?.length || 0}
                </td>
                <td style={{ padding: "12px", textAlign: "center" }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(t);
                    }}
                    style={{
                      padding: "6px 12px",
                      marginRight: "6px",
                      background: "#3b82f6",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontWeight: 500,
                      transition: "all 0.2s ease"
                    }}
                    onMouseEnter={(e) => e.target.style.background = "#2563eb"}
                    onMouseLeave={(e) => e.target.style.background = "#3b82f6"}
                  >
                    Edit
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(t.id);
                    }}
                    style={{
                      padding: "6px 12px",
                      background: "#ef4444",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontSize: "12px",
                      fontWeight: 500,
                      transition: "all 0.2s ease"
                    }}
                    onMouseEnter={(e) => e.target.style.background = "#dc2626"}
                    onMouseLeave={(e) => e.target.style.background = "#ef4444"}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
