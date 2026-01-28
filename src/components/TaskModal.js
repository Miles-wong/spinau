import React, { useEffect, useState } from "react";
import LoadEditor from "./LoadEditor";

function parseISODate(d) {
  if (typeof d !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, da);
  const dt = new Date(utc);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) return null;
  return { utc };
}

function isValidDate(d) {
  return Boolean(parseISODate(d));
}

export default function TaskModal({ isOpen, mode, initialTask, onClose, onSave }) {
  const isEdit = mode === "edit";

  const [task, setTask] = useState(null);
  const [workloads, setWorkloads] = useState([]);
  const [errors, setErrors] = useState({});
  const [workloadErrors, setWorkloadErrors] = useState({});
  const [info, setInfo] = useState("");

  useEffect(() => {
    if (!isOpen) return;

    if (initialTask) {
      setTask({ ...initialTask });
      // add stable UI cid
      const loads = (initialTask.workloads || []).map((w) => ({
        ...w,
        _cid: crypto?.randomUUID?.() || String(Date.now() + Math.random())
      }));
      setWorkloads(loads);
    } else {
      setTask({
        id: null,
        taskName: "",
        description: "",
        startDate: "",
        endDate: "",
        requestedBy: "",
        assignedTo: "",
        status: "In Progress",
        project: "",
        workloads: []
      });
      setWorkloads([]);
    }

    setErrors({});
    setWorkloadErrors({});
    setInfo("");
  }, [isOpen, initialTask]);

  if (!isOpen || !task) return null;

  const setField = (field, value) => {
    setInfo("");
    setTask((prev) => ({ ...prev, [field]: value }));
  };

  const validate = () => {
    const e = {};
    const we = {};

    if (!task.taskName.trim()) e.taskName = "Task name required";

    if (!isValidDate(task.startDate)) e.startDate = "Valid start date required";
    if (!isValidDate(task.endDate)) e.endDate = "Valid end date required";

    if (isValidDate(task.startDate) && isValidDate(task.endDate) && task.startDate > task.endDate) {
      e.range = "Task start must be before end";
    }

    workloads.forEach((w, idx) => {
      if (!isValidDate(w.startDate) || !isValidDate(w.endDate)) {
        we[idx] = "Both dates required (valid date)";
        return;
      }
      if (w.startDate > w.endDate) {
        we[idx] = "Workload start must be before end";
        return;
      }
      if (isValidDate(task.startDate) && isValidDate(task.endDate)) {
        if (w.startDate < task.startDate || w.endDate > task.endDate) {
          we[idx] = "Workload must be inside task range";
        }
      }
    });

    setErrors(e);
    setWorkloadErrors(we);

    return Object.keys(e).length === 0 && Object.keys(we).length === 0;
  };

  const handleSave = () => {
    if (!validate()) {
      if (!task.taskName.trim()) {
        setInfo("⚠️ Task name is required");
      }
      return;
    }

    // strip UI-only fields
    const cleanedWorkloads = workloads.map(({ startDate, endDate }) => ({ startDate, endDate }));

    onSave({ ...task, workloads: cleanedWorkloads });
  };

  return (
    <div className="modalOverlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{isEdit ? "Edit Task" : "Create Task"}</h2>

        {info ? (
          <div style={{ 
            background: "#eff6ff", 
            border: "1px solid #93c5fd", 
            color: "#1e40af",
            padding: "12px 16px", 
            borderRadius: "8px", 
            marginBottom: 16, 
            fontSize: "14px",
            fontWeight: 500
          }}>
            {info}
          </div>
        ) : null}

        <div className="field">
          <label>Task Name *</label>
          <input 
            placeholder="Enter task name (required)" 
            value={task.taskName} 
            onChange={(e) => setField("taskName", e.target.value)} 
          />
          {errors.taskName && <div className="error">{errors.taskName}</div>}
        </div>

        <div className="field">
          <label>Description</label>
          <input value={task.description} onChange={(e) => setField("description", e.target.value)} />
        </div>

        <div className="field">
          <label>Requested By</label>
          <input value={task.requestedBy} onChange={(e) => setField("requestedBy", e.target.value)} />
        </div>

        <div className="field">
          <label>Assigned To</label>
          <input value={task.assignedTo} onChange={(e) => setField("assignedTo", e.target.value)} />
        </div>

        <div className="field">
          <label>Status</label>
          <select value={task.status} onChange={(e) => setField("status", e.target.value)}>
            <option>Not Started</option>
            <option>In Progress</option>
            <option>Completed</option>
          </select>
        </div>

        <div className="field">
          <label>Project</label>
          <input value={task.project} onChange={(e) => setField("project", e.target.value)} />
        </div>

        <div className="field">
          <label>Start Date *</label>
          <input type="date" value={task.startDate} onChange={(e) => setField("startDate", e.target.value)} />
          {errors.startDate && <div className="error">{errors.startDate}</div>}
        </div>

        <div className="field">
          <label>End Date *</label>
          <input type="date" value={task.endDate} onChange={(e) => setField("endDate", e.target.value)} />
          {errors.endDate && <div className="error">{errors.endDate}</div>}
        </div>

        {errors.range && <div className="error">{errors.range}</div>}

        <LoadEditor
          taskStart={task.startDate}
          taskEnd={task.endDate}
          workloads={workloads}
          setWorkloads={setWorkloads}
          errors={workloadErrors}
          onAdjusted={() => setInfo("Some workloads were adjusted to fit the updated task date range.")}
        />

        <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
          <button 
            type="button" 
            onClick={handleSave}
            style={{
              flex: 1,
              padding: "12px 24px",
              background: "linear-gradient(135deg, #1e40af 0%, #1e3a8a 100%)",
              color: "white",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "15px",
              boxShadow: "0 4px 15px rgba(30, 64, 175, 0.3)",
              transition: "all 0.3s ease"
            }}
            onMouseEnter={(e) => {
              e.target.style.background = "linear-gradient(135deg, #1e3a8a 0%, #172554 100%)";
              e.target.style.transform = "translateY(-2px)";
              e.target.style.boxShadow = "0 6px 20px rgba(30, 64, 175, 0.4)";
            }}
            onMouseLeave={(e) => {
              e.target.style.background = "linear-gradient(135deg, #1e40af 0%, #1e3a8a 100%)";
              e.target.style.transform = "translateY(0)";
              e.target.style.boxShadow = "0 4px 15px rgba(30, 64, 175, 0.3)";
            }}
          >
            {isEdit ? "Save Changes" : "Create"}
          </button>
          <button 
            type="button" 
            onClick={onClose}
            style={{
              flex: 1,
              padding: "12px 24px",
              background: "#e2e8f0",
              color: "#1e293b",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "15px",
              transition: "all 0.3s ease"
            }}
            onMouseEnter={(e) => {
              e.target.style.background = "#cbd5e1";
              e.target.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={(e) => {
              e.target.style.background = "#e2e8f0";
              e.target.style.transform = "translateY(0)";
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
