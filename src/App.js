import React, { useEffect, useState } from "react";
import initialTasks from "./data/tasks.json";
import Table from "./components/Table";
import TaskModal from "./components/TaskModal";

const STORAGE_KEY = "spin_tasks_v1";

/**
 * Get tasks from localStorage first (persistent), otherwise load from JSON file.
 * This prevents "refresh clears data" bug.
 */
function loadInitialTasks() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : initialTasks;
  } catch {
    return initialTasks;
  }
}

/**
 * Generate next numeric task id (matches reference JSON: "id": 1)
 */
function getNextTaskId(tasks) {
  const maxId = tasks.reduce((max, t) => {
    const idNum = typeof t.id === "number" ? t.id : Number(t.id);
    return Number.isFinite(idNum) ? Math.max(max, idNum) : max;
  }, 0);
  return maxId + 1;
}

export default function App() {
  // ✅ Initialize from localStorage or initial JSON.
  const [tasks, setTasks] = useState(() => loadInitialTasks());

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);

  // Storage warning (in case localStorage is blocked/full)
  const [storageError, setStorageError] = useState("");

  // ✅ Toast message
  const [toast, setToast] = useState("");

  const showToast = (msg) => {
    setToast(msg);
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(""), 1800);
  };

  // ✅ Persist tasks whenever changed
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      setStorageError("");
    } catch {
      setStorageError(
        "Warning: Unable to save to localStorage (storage full or blocked). Changes may not persist."
      );
    }
  }, [tasks]);

  // Open create modal
  const openCreate = () => {
    setEditingTask(null);
    setIsModalOpen(true);
  };

  // Open edit modal
  const openEdit = (task) => {
    setEditingTask(task);
    setIsModalOpen(true);
  };

  // Save task (create/edit)
  const handleSaveTask = (taskPayload) => {
    setTasks((prev) => {
      const exists = prev.some((t) => t.id === taskPayload.id);

      // Create: assign numeric id
      if (!exists) {
        const newTask = {
          ...taskPayload,
          id: getNextTaskId(prev),
        };
        showToast("Task created successfully.");
        return [newTask, ...prev];
      }

      // Edit: update
      showToast("Task updated successfully.");
      return prev.map((t) => (t.id === taskPayload.id ? taskPayload : t));
    });

    setIsModalOpen(false);
  };

  // Delete
  const handleDeleteTask = (taskId) => {
    if (!window.confirm("Delete this task?")) return;

    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    showToast("Task deleted.");
  };

  return (
    <div style={{ padding: 20 }}>
      {/* ✅ Toast UI */}
      {toast ? (
        <div
          style={{
            position: "fixed",
            top: 18,
            right: 18,
            padding: "10px 12px",
            border: "1px solid #ddd",
            background: "white",
            borderRadius: 10,
            boxShadow: "0 6px 18px rgba(0,0,0,0.12)",
            zIndex: 9999,
          }}
        >
          {toast}
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>SPIN Task Management</h1>
        <button onClick={openCreate}>+ Create Task</button>
      </div>

      {/* ✅ Storage warning */}
      {storageError ? (
        <div style={{ marginTop: 10, padding: 10, border: "1px solid #ddd" }}>
          {storageError}
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Table
          tasks={tasks}
          onDoubleClickRow={openEdit}
          onEdit={openEdit}
          onDelete={handleDeleteTask}
        />
      </div>

      <TaskModal
        isOpen={isModalOpen}
        mode={editingTask ? "edit" : "create"}
        initialTask={editingTask}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveTask}
      />
    </div>
  );
}
