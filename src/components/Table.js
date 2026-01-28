import React from "react";

export default function Table({ tasks, onDoubleClickRow, onEdit, onDelete }) {
  return (
    <table border="1" cellPadding="8" style={{ width: "100%", marginTop: 12 }}>
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
            <td colSpan="7" style={{ textAlign: "center" }}>No tasks yet.</td>
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
                <div><b>{t.taskName}</b></div>
                <div style={{ opacity: 0.75 }}>{t.description || ""}</div>
              </td>
              <td>{t.project || "-"}</td>
              <td>{t.status || "-"}</td>
              <td>{t.startDate} → {t.endDate}</td>
              <td>{t.workloads?.length || 0}</td>
              <td>
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(t); }}
                >
                  Edit
                </button>{" "}
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
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
