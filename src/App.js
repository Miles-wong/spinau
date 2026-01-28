import React, { useEffect, useState } from "react";
import initialTasks from "./data/tasks.json";
import Table from "./components/Table";
import TaskModal from "./components/TaskModal";

const STORAGE_KEY = "spin_tasks_v1";

function loadInitialTasks() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : initialTasks;
  } catch {
    return initialTasks;
  }
}

function getNextTaskId(tasks) {
  const maxId = tasks.reduce((max, t) => {
    const idNum = typeof t.id === "number" ? t.id : Number(t.id);
    return Number.isFinite(idNum) ? Math.max(max, idNum) : max;
  }, 0);
  return maxId + 1;
}

export default function App() {
  const [tasks, setTasks] = useState(() => loadInitialTasks());
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [storageError, setStorageError] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      setStorageError("");
    } catch {
      setStorageError("Warning: Unable to save to localStorage (storage full or blocked). Changes may not persist.");
    }
  }, [tasks]);

  const openCreate = () => {
    setEditingTask(null);
    setIsModalOpen(true);
  };

  const openEdit = (task) => {
    setEditingTask(task);
    setIsModalOpen(true);
  };

  const handleSaveTask = (taskPayload) => {
    setTasks((prev) => {
      const exists = prev.some((t) => t.id === taskPayload.id);

      if (!exists) {
        const newTask = { ...taskPayload, id: getNextTaskId(prev) };
        return [newTask, ...prev];
      }

      return prev.map((t) => (t.id === taskPayload.id ? taskPayload : t));
    });

    setIsModalOpen(false);
  };

  const handleDeleteTask = (taskId) => {
    if (!window.confirm("Delete this task?")) return;
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>SPIN Task Management</h1>
        <button onClick={openCreate}>+ Create Task</button>
      </div>

      {storageError ? (
        <div style={{ marginTop: 10, padding: 10, border: "1px solid #ddd" }}>
          {storageError}
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Table tasks={tasks} onDoubleClickRow={openEdit} onEdit={openEdit} onDelete={handleDeleteTask} />
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
