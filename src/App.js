import React, { useEffect, useState, useCallback } from "react";
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
  const openCreate = useCallback(() => {
    setEditingTask(null);
    setIsModalOpen(true);
  }, []);

  // Open edit modal
  const openEdit = useCallback((task) => {
    setEditingTask(task);
    setIsModalOpen(true);
  }, []);

  // Save task (create/edit)
  const handleSaveTask = useCallback((taskPayload) => {
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
  }, []);

  // Delete
  const handleDeleteTask = useCallback((taskId) => {
    if (!window.confirm("Delete this task?")) return;

    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    showToast("Task deleted.");
  }, []);

  return (
    <div className="App">
      {/* ✅ Toast UI */}
      {toast ? (
        <div className="toast">
          {toast}
        </div>
      ) : null}

      <div className="app-container">
        <div className="app-header">
          <h1>SPIN Task Management</h1>
          <button 
            onClick={openCreate}
            className="create-button"
            title="Create a new task"
          >
            ✨ Create Task
          </button>
        </div>

        {/* ✅ Storage warning */}
        {storageError ? (
          <div className="storage-warning">
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
