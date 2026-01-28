import React, { useEffect } from "react";

/** strict ISO date check */
function parseISODate(d) {
  if (typeof d !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, da);
  const dt = new Date(utc);
  // validate real date
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== da
  ) return null;
  return { y, mo, da, utc };
}

function isValidDate(d) {
  return Boolean(parseISODate(d));
}

/** normalize workload into legal range + friendly auto-fix */
function normalizeWorkload(w, taskStart, taskEnd) {
  const canLimitRange =
    isValidDate(taskStart) && isValidDate(taskEnd) && taskStart <= taskEnd;

  let s = w.startDate || "";
  let e = w.endDate || "";

  // Auto-fix reverse
  if (s && e && s > e) {
    e = s;
  }

  // Clamp into task range
  if (canLimitRange) {
    if (s && s < taskStart) s = taskStart;
    if (s && s > taskEnd) s = taskEnd;

    if (e && e < taskStart) e = taskStart;
    if (e && e > taskEnd) e = taskEnd;

    if (s && e && s > e) e = s;
  }

  return { ...w, startDate: s, endDate: e };
}

/** Inclusive day count */
function calcDurationDays(startDate, endDate) {
  const ps = parseISODate(startDate);
  const pe = parseISODate(endDate);
  if (!ps || !pe) return null;
  if (ps.utc > pe.utc) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((pe.utc - ps.utc) / msPerDay) + 1;
}

/**
 * workloads schema (saved): [{ startDate, endDate }]
 * workloads UI (in-memory): [{ startDate, endDate, _cid }]
 */
export default function LoadEditor({ taskStart, taskEnd, workloads, setWorkloads, errors, onAdjusted }) {
  const canLimitRange = isValidDate(taskStart) && isValidDate(taskEnd) && taskStart <= taskEnd;

  const addWorkload = () => {
    if (!canLimitRange) return;
    setWorkloads((prev) => [
      ...prev,
      { _cid: crypto?.randomUUID?.() || String(Date.now() + Math.random()), startDate: taskStart, endDate: taskStart }
    ]);
  };

  const updateWorkload = (index, field, value) => {
    setWorkloads((prev) =>
      prev.map((w, i) => {
        if (i !== index) return w;
        const next = normalizeWorkload({ ...w, [field]: value }, taskStart, taskEnd);
        return next;
      })
    );
  };

  const removeWorkload = (index) => {
    setWorkloads((prev) => prev.filter((_, i) => i !== index));
  };

  // Clamp all workloads when task range changes + notify if any adjusted
  useEffect(() => {
    if (!canLimitRange) return;

    setWorkloads((prev) => {
      let adjusted = false;

      const next = prev.map((w) => {
        const norm = normalizeWorkload(w, taskStart, taskEnd);
        if (norm.startDate !== w.startDate || norm.endDate !== w.endDate) adjusted = true;
        return norm;
      });

      if (adjusted && typeof onAdjusted === "function") onAdjusted();
      return next;
    });
  }, [taskStart, taskEnd, canLimitRange, setWorkloads, onAdjusted]);

  return (
    <div style={{ marginTop: 24, paddingTop: 20, borderTop: "2px solid #e2e8f0" }}>
      <h3 style={{ margin: "0 0 16px 0", fontSize: "16px", fontWeight: 700, color: "#1e293b" }}>Workloads</h3>

      <button 
        type="button" 
        onClick={addWorkload} 
        disabled={!canLimitRange}
        style={{
          padding: "8px 16px",
          background: canLimitRange ? "#10b981" : "#cbd5e1",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: canLimitRange ? "pointer" : "not-allowed",
          fontSize: "14px",
          fontWeight: 600,
          transition: "all 0.2s ease"
        }}
        onMouseEnter={(e) => canLimitRange && (e.target.style.background = "#059669")}
        onMouseLeave={(e) => canLimitRange && (e.target.style.background = "#10b981")}
      >
        + Add Workload
      </button>

      {!canLimitRange ? (
        <p style={{ opacity: 0.7, marginTop: 12, fontSize: "14px", color: "#64748b" }}>
          Please set a valid Task Start/End date first.
        </p>
      ) : null}

      {workloads.length === 0 ? (
        <p style={{ opacity: 0.7, marginTop: 12, fontSize: "14px", color: "#64748b" }}>No workloads yet.</p>
      ) : (
        workloads.map((w, index) => {
          const endMin =
            canLimitRange && w.startDate && w.startDate > taskStart ? w.startDate : taskStart;

          const duration = calcDurationDays(w.startDate, w.endDate);

          return (
            <div 
              key={w._cid || `${index}`} 
              style={{ 
                marginTop: 12, 
                border: "1.5px solid #e2e8f0", 
                borderRadius: "8px",
                padding: 16,
                background: "#f8fafc"
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontWeight: 600, color: "#1e293b" }}>Workload #{index + 1}</div>
                <div style={{ fontSize: "13px", color: "#64748b", fontWeight: 500 }}>
                  Duration: {duration === null ? "—" : `${duration} day(s)`}
                </div>
              </div>

              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <label style={{ flex: 1, minWidth: "200px", fontSize: "14px", fontWeight: 500, color: "#334155" }}>
                  Start:
                  <input
                    type="date"
                    value={w.startDate}
                    min={canLimitRange ? taskStart : undefined}
                    max={canLimitRange ? taskEnd : undefined}
                    onChange={(e) => updateWorkload(index, "startDate", e.target.value)}
                    style={{
                      display: "block",
                      marginTop: 6,
                      padding: "8px 10px",
                      border: "1.5px solid #e2e8f0",
                      borderRadius: "6px",
                      fontSize: "13px",
                      width: "100%",
                      background: "white"
                    }}
                  />
                </label>

                <label style={{ flex: 1, minWidth: "200px", fontSize: "14px", fontWeight: 500, color: "#334155" }}>
                  End:
                  <input
                    type="date"
                    value={w.endDate}
                    min={canLimitRange ? endMin : undefined}
                    max={canLimitRange ? taskEnd : undefined}
                    onChange={(e) => updateWorkload(index, "endDate", e.target.value)}
                    style={{
                      display: "block",
                      marginTop: 6,
                      padding: "8px 10px",
                      border: "1.5px solid #e2e8f0",
                      borderRadius: "6px",
                      fontSize: "13px",
                      width: "100%",
                      background: "white"
                    }}
                  />
                </label>

                <button 
                  type="button" 
                  onClick={() => removeWorkload(index)}
                  style={{
                    padding: "8px 14px",
                    background: "#ef4444",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: 600,
                    marginTop: 28,
                    transition: "all 0.2s ease"
                  }}
                  onMouseEnter={(e) => e.target.style.background = "#dc2626"}
                  onMouseLeave={(e) => e.target.style.background = "#ef4444"}
                >
                  Remove
                </button>
              </div>

              {errors?.[index] ? (
                <div style={{ color: "#dc2626", marginTop: 10, fontSize: "13px", fontWeight: 500 }}>
                  ⚠️ {errors[index]}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
