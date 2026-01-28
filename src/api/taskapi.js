/**
 * Task API Module
 * Handles all API calls related to task management
 * 
 * Usage Example:
 * import { fetchTasks, createTask, updateTask, deleteTask } from './api/taskapi';
 */

// API Base Configuration
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const TIMEOUT = 10000; // 10 seconds timeout

/**
 * Generic request method
 * @param {string} endpoint - API endpoint
 * @param {object} options - fetch configuration options
 * @returns {Promise} Response data
 */
async function apiCall(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const defaultOptions = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal: controller.signal,
    };

    const response = await fetch(url, { ...defaultOptions, ...options });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { success: false, error: 'Request timeout' };
    }
    return { success: false, error: error.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ==================== Task CRUD Operations ====================

/**
 * Fetch all tasks
 * @param {object} params - Query parameters { page, pageSize, status, projectId }
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
export async function fetchTasks(params = {}) {
  const queryString = new URLSearchParams(params).toString();
  const endpoint = `/tasks${queryString ? `?${queryString}` : ''}`;
  return apiCall(endpoint, { method: 'GET' });
}

/**
 * Fetch a single task details
 * @param {number} taskId - Task ID
 * @returns {Promise}
 */
export async function fetchTaskById(taskId) {
  return apiCall(`/tasks/${taskId}`, { method: 'GET' });
}

/**
 * Create a new task
 * @param {object} taskData - Task data
 * @returns {Promise}
 */
export async function createTask(taskData) {
  return apiCall('/tasks', {
    method: 'POST',
    body: JSON.stringify(taskData),
  });
}

/**
 * Update a task
 * @param {number} taskId - Task ID
 * @param {object} taskData - Updated task data
 * @returns {Promise}
 */
export async function updateTask(taskId, taskData) {
  return apiCall(`/tasks/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify(taskData),
  });
}

/**
 * Delete a task
 * @param {number} taskId - Task ID
 * @returns {Promise}
 */
export async function deleteTask(taskId) {
  return apiCall(`/tasks/${taskId}`, { method: 'DELETE' });
}

// ==================== Workload Operations ====================

/**
 * Add a workload
 * @param {number} taskId - Task ID
 * @param {object} workloadData - Workload data
 * @returns {Promise}
 */
export async function addWorkload(taskId, workloadData) {
  return apiCall(`/tasks/${taskId}/workloads`, {
    method: 'POST',
    body: JSON.stringify(workloadData),
  });
}

/**
 * Update a workload
 * @param {number} taskId - Task ID
 * @param {number} workloadId - Workload ID
 * @param {object} workloadData - Updated workload data
 * @returns {Promise}
 */
export async function updateWorkload(taskId, workloadId, workloadData) {
  return apiCall(`/tasks/${taskId}/workloads/${workloadId}`, {
    method: 'PUT',
    body: JSON.stringify(workloadData),
  });
}

/**
 * Delete a workload
 * @param {number} taskId - Task ID
 * @param {number} workloadId - Workload ID
 * @returns {Promise}
 */
export async function deleteWorkload(taskId, workloadId) {
  return apiCall(`/tasks/${taskId}/workloads/${workloadId}`, {
    method: 'DELETE',
  });
}

// ==================== Filter & Search Operations ====================

/**
 * Filter tasks by status
 * @param {string} status - Task status
 * @returns {Promise}
 */
export async function fetchTasksByStatus(status) {
  return apiCall(`/tasks?status=${encodeURIComponent(status)}`, {
    method: 'GET',
  });
}

/**
 * Filter tasks by project
 * @param {string} projectId - Project ID
 * @returns {Promise}
 */
export async function fetchTasksByProject(projectId) {
  return apiCall(`/tasks?projectId=${encodeURIComponent(projectId)}`, {
    method: 'GET',
  });
}

/**
 * Search tasks
 * @param {string} keyword - Search keyword
 * @returns {Promise}
 */
export async function searchTasks(keyword) {
  return apiCall(`/tasks/search?keyword=${encodeURIComponent(keyword)}`, {
    method: 'GET',
  });
}

// ==================== Batch Operations ====================

/**
 * Batch delete tasks
 * @param {array} taskIds - Task ID array
 * @returns {Promise}
 */
export async function bulkDeleteTasks(taskIds) {
  return apiCall('/tasks/batch/delete', {
    method: 'POST',
    body: JSON.stringify({ ids: taskIds }),
  });
}

/**
 * Batch update task status
 * @param {array} taskIds - Task ID array
 * @param {string} status - New status
 * @returns {Promise}
 */
export async function bulkUpdateStatus(taskIds, status) {
  return apiCall('/tasks/batch/update-status', {
    method: 'POST',
    body: JSON.stringify({ ids: taskIds, status }),
  });
}

// ==================== Statistics & Analytics ====================

/**
 * Fetch task statistics
 * @returns {Promise}
 */
export async function fetchTaskStatistics() {
  return apiCall('/tasks/statistics', { method: 'GET' });
}

/**
 * Fetch project task statistics
 * @param {string} projectId - Project ID
 * @returns {Promise}
 */
export async function fetchProjectStatistics(projectId) {
  return apiCall(`/projects/${projectId}/statistics`, { method: 'GET' });
}

// ==================== Export Configuration ====================

/**
 * Export task data
 * @param {object} params - Export parameters { format, filters }
 * @returns {Promise}
 */
export async function exportTasks(params = {}) {
  return apiCall('/tasks/export', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ==================== Error Handling Helper ====================

/**
 * Handle API response
 * @param {Promise} apiPromise - Promise of API call
 * @param {function} onSuccess - Success callback
 * @param {function} onError - Error callback
 */
export async function handleApiResponse(apiPromise, onSuccess, onError) {
  try {
    const response = await apiPromise;
    if (response.success) {
      onSuccess?.(response.data);
    } else {
      onError?.(response.error);
    }
  } catch (error) {
    onError?.(error.message);
  }
}
