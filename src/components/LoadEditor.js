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
    <div style={{ marginTop: 15 }}>
      <h3>Workloads</h3>

      <button type="button" onClick={addWorkload} disabled={!canLimitRange}>
        + Add Workload
      </button>

      {!canLimitRange ? (
        <p style={{ opacity: 0.8, marginTop: 8 }}>
          Please set a valid Task Start/End date first.
        </p>
      ) : null}

      {workloads.length === 0 ? (
        <p style={{ opacity: 0.8 }}>No workloads yet.</p>
      ) : (
        workloads.map((w, index) => {
          const endMin =
            canLimitRange && w.startDate && w.startDate > taskStart ? w.startDate : taskStart;

          const duration = calcDurationDays(w.startDate, w.endDate);

          return (
            <div key={w._cid || `${index}`} style={{ marginTop: 10, border: "1px solid #ccc", padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div><b>Workload #{index + 1}</b></div>
                <div style={{ opacity: 0.8 }}>
                  Duration: {duration === null ? "—" : `${duration} day(s)`}
                </div>
              </div>

              <div style={{ marginTop: 8 }}>
                <label style={{ marginRight: 8 }}>
                  Start:{" "}
                  <input
                    type="date"
                    value={w.startDate}
                    min={canLimitRange ? taskStart : undefined}
                    max={canLimitRange ? taskEnd : undefined}
                    onChange={(e) => updateWorkload(index, "startDate", e.target.value)}
                  />
                </label>

                <label style={{ marginRight: 8 }}>
                  End:{" "}
                  <input
                    type="date"
                    value={w.endDate}
                    min={canLimitRange ? endMin : undefined}
                    max={canLimitRange ? taskEnd : undefined}
                    onChange={(e) => updateWorkload(index, "endDate", e.target.value)}
                  />
                </label>

                <button type="button" onClick={() => removeWorkload(index)}>
                  Remove
                </button>
              </div>

              {errors?.[index] ? (
                <div style={{ color: "red", marginTop: 6 }}>{errors[index]}</div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
