import React from "react";

function StatusBadge({ status }) {
  const s = status || "Not Started";

  const styleMap = {
    "Not Started": { background: "#f2f2f2", color: "#333", border: "#ddd" },
    "In Progress": { background: "#e8f0ff", color: "#1d4ed8", border: "#bcd3ff" },
    "Completed": { background: "#e9f8ee", color: "#166534", border: "#bfe8cc" }
  };

  const st = styleMap[s] || styleMap["Not Started"];

  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        border: `1px solid ${st.border}`,
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
    <table
      border="1"
      cellPadding="8"
      style={{ width: "100%", marginTop: 12, borderCollapse: "collapse" }}
    >
      <thead>
        <tr>
          <th>ID</th>
          <th>Task</th>
          <th>Project</th>
          <th>Status</th>
          <th>Date Range</th>
          <th># Workloads</th>
          <th>Actions</th>
        </tr>
      </thead>

      <tbody>
        {tasks.length === 0 ? (
          <tr>
            <td colSpan="7" style={{ textAlign: "center", padding: 18 }}>
              <div style={{ fontWeight: 600 }}>No tasks yet.</div>
              <div style={{ opacity: 0.8, marginTop: 4 }}>
                Click <b>+ Create Task</b> to get started.
              </div>
            </td>
          </tr>
        ) : (
          tasks.map((t) => (
            <tr
              key={t.id}
              onDoubleClick={() => onDoubleClickRow(t)}
              style={{ cursor: "pointer" }}
            >
              <td>{t.id}</td>
              <td>
                <div>
                  <b>{t.taskName}</b>
                </div>
                <div style={{ opacity: 0.75 }}>{t.description || ""}</div>
              </td>
              <td>{t.project || "-"}</td>
              <td>
                <StatusBadge status={t.status} />
              </td>
              <td>
                {t.startDate} → {t.endDate}
              </td>
              <td>{t.workloads?.length || 0}</td>
              <td>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(t);
                  }}
                >
                  Edit
                </button>{" "}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(t.id);
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
