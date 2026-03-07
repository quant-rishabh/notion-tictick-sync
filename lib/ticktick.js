/**
 * TickTick API Client - Using Open API
 *
 * Uses Bearer token authentication (same as index.html)
 */

// Open API credentials
const TICKTICK_BEARER_TOKEN = process.env.TICKTICK_BEARER_TOKEN || 'tp_73795d4ca7444706a018d11ebd34aca8';
const TICKTICK_USER_ID = process.env.TICKTICK_USER_ID || '116952856';
const TICKTICK_API_BASE = 'https://api.ticktick.com/open/v1';

// Cookie API credentials (for search endpoint)
const TICKTICK_COOKIE_TOKEN = process.env.TICKTICK_COOKIE_TOKEN || '0CAB80045A64122BECEF2EA40309CBDF4C1BB731656F704BFC4D0642B714BD9B36CC2F8A6DD559FB36587213B425326F3F425DFB7A04D6B9DA4F30DF737F2A6AB4FAAC5121D78B9B4F035FD5B50870EAC3901D5762A9C898F15EFA0893889F977A7AD753CC8186DEA55F3B07C719D0A3711F9CAEDB907858368E60D28CADEC367A7AD753CC8186DE53BF302581B042C7C2AF0C87EB5E1C3CB2780A9BFC727FF7F50AEF606045DE4B368E82C9F4AF78EEB582241102B75021';
const TICKTICK_COOKIE_CSRF = process.env.TICKTICK_COOKIE_CSRF || 'a2kXQxVBKp5MNAOhafEIUlQBjo2HAqghUX6Xn5X0pjo-1771904551';

// Special tag to identify Notion-synced tasks (efficient filtering!)
const NOTION_SYNC_TAG = 'notion-sync';

// Headers for Open API
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${TICKTICK_BEARER_TOKEN}`,
};

// Cookie headers for search API
function getCookieHeaders() {
  return {
    'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`,
    'x-csrftoken': TICKTICK_COOKIE_CSRF,
    'Content-Type': 'application/json'
  };
}

/**
 * Make a request to TickTick Open API
 */
async function ticktickRequest(endpoint, options = {}) {
  const url = `${TICKTICK_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...options.headers
    }
  });

  // Some endpoints return empty response
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = text;
    }
  }

  if (!response.ok) {
    console.error('TickTick API Error:', response.status, data);
    throw new Error(`TickTick API error: ${response.status}`);
  }

  return data;
}

/**
 * Get inbox ID
 */
function getInboxId() {
  return `inbox${TICKTICK_USER_ID}`;
}

/**
 * Get all projects (lists)
 */
export async function getProjects() {
  const projects = await ticktickRequest('/project');
  // Add inbox as a project
  const inboxId = getInboxId();
  if (!projects.find(p => p.id === inboxId)) {
    projects.push({ id: inboxId, name: 'Inbox', color: '#4CAF50' });
  }
  return projects;
}

/**
 * Get all tasks including inbox
 */
export async function getAllTasks() {
  const projects = await getProjects();
  let allTasks = [];

  // Fetch from each project including inbox
  for (const project of projects) {
    try {
      const projectData = await ticktickRequest(`/project/${project.id}/data`);
      if (projectData && projectData.tasks) {
        allTasks = allTasks.concat(projectData.tasks);
      }
    } catch (e) {
      console.log(`Could not fetch project ${project.id}:`, e.message);
    }
  }

  return { tasks: allTasks };
}

/**
 * EFFICIENT: Get completed Notion-synced tasks
 * Uses Filter API - much faster than cookie API!
 */
export async function getCompletedNotionTasks() {
  const response = await fetch(`${TICKTICK_API_BASE}/task/filter`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tag: [NOTION_SYNC_TAG],
      status: [2]  // Completed only
    })
  });
  
  if (!response.ok) {
    console.error('Filter API error:', response.status);
    return [];
  }
  
  return await response.json() || [];
}

/**
 * EFFICIENT: Search for Notion-synced tasks only
 * Uses Filter API with notion-sync tag - returns only synced tasks!
 * @param {object} options - { status: [0] (uncompleted), tags: ['extra-tag'] }
 */
export async function getNotionSyncedTasks(options = {}) {
  const body = {
    tag: [NOTION_SYNC_TAG],  // Always filter by notion-sync tag
    status: options.status || [0, 2]  // Default: both open and completed
  };
  
  // Add additional tags if specified
  if (options.tags && options.tags.length > 0) {
    body.tag = [NOTION_SYNC_TAG, ...options.tags];
  }
  
  const response = await fetch(`${TICKTICK_API_BASE}/task/filter`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    console.error('Filter API error:', response.status);
    return { tasks: [] };
  }
  
  const tasks = await response.json();
  return { tasks: tasks || [] };
}

/**
 * Create a new task
 */
export async function createTask(task) {
  const taskData = {
    title: task.title,
    projectId: task.projectId || getInboxId(), // Default to inbox
    content: task.content || '',
    priority: task.priority || 0,
    isAllDay: true,
  };

  // Add tags if present (array of strings)
  // Always add NOTION_SYNC_TAG for efficient filtering!
  const tags = task.tags ? [...task.tags] : [];
  if (!tags.includes(NOTION_SYNC_TAG)) {
    tags.push(NOTION_SYNC_TAG);
  }
  taskData.tags = tags;

  // Add due date if present
  if (task.dueDate) {
    taskData.dueDate = task.dueDate;
  }

  // Add repeat flag if present
  if (task.repeatFlag) {
    taskData.repeatFlag = task.repeatFlag;
  }

  const result = await ticktickRequest('/task', {
    method: 'POST',
    body: JSON.stringify(taskData)
  });

  return {
    id: result.id,
    ...taskData,
    result
  };
}

/**
 * Update an existing task
 */
export async function updateTask(task) {
  const taskId = task.id;
  const projectId = task.projectId || getInboxId();
  
  const updateData = {
    ...task,
    projectId
  };

  // Ensure tags is an array if present
  if (task.tags && !Array.isArray(task.tags)) {
    updateData.tags = [task.tags];
  }

  return ticktickRequest(`/task/${taskId}`, {
    method: 'POST',
    body: JSON.stringify(updateData)
  });
}

/**
 * Move a task to a different project
 */
export async function moveTask(taskId, fromProjectId, toProjectId) {
  return ticktickRequest('/task/move', {
    method: 'POST',
    body: JSON.stringify([{
      taskId: taskId,
      fromProjectId: fromProjectId,
      toProjectId: toProjectId
    }])
  });
}

/**
 * Complete a task
 */
export async function completeTask(taskId, projectId) {
  projectId = projectId || getInboxId();
  return ticktickRequest(`/project/${projectId}/task/${taskId}/complete`, {
    method: 'POST'
  });
}

/**
 * Delete a task
 */
export async function deleteTask(taskId, projectId) {
  projectId = projectId || getInboxId();
  return ticktickRequest(`/project/${projectId}/task/${taskId}`, {
    method: 'DELETE'
  });
}

/**
 * Get completed tasks from all projects
 * Uses cookie API since Open API doesn't have completed endpoint
 * @param {number} minutesAgo - Get tasks completed in last N minutes (default: 10)
 */
export async function getCompletedTasks(minutesAgo = 10) {
  const now = new Date();
  const startTime = new Date(now.getTime() - minutesAgo * 60 * 1000);
  
  // Cookie API credentials (Open API doesn't have completed endpoint)
  const COOKIE_TOKEN = process.env.TICKTICK_COOKIE_TOKEN || '0CAB80045A64122BECEF2EA40309CBDF4C1BB731656F704BFC4D0642B714BD9B36CC2F8A6DD559FB36587213B425326F3F425DFB7A04D6B9DA4F30DF737F2A6AB4FAAC5121D78B9B4F035FD5B50870EAC3901D5762A9C898F15EFA0893889F977A7AD753CC8186DEA55F3B07C719D0A3711F9CAEDB907858368E60D28CADEC367A7AD753CC8186DE53BF302581B042C7C2AF0C87EB5E1C3CB2780A9BFC727FF7F50AEF606045DE4B368E82C9F4AF78EEB582241102B75021';
  const COOKIE_CSRF = process.env.TICKTICK_COOKIE_CSRF || 'a2kXQxVBKp5MNAOhafEIUlQBjo2HAqghUX6Xn5X0pjo-1771904551';
  
  const cookieHeaders = {
    'Cookie': `t=${COOKIE_TOKEN}`,
    'x-csrftoken': COOKIE_CSRF
  };
  
  // Get projects using cookie API
  const projRes = await fetch('https://api.ticktick.com/api/v2/projects', { headers: cookieHeaders });
  const projects = await projRes.json();
  
  // Add inbox to the list (it's not in /projects)
  const inboxId = getInboxId();
  projects.push({ id: inboxId, name: 'Inbox' });
  
  let allCompleted = [];

  // Fetch completed tasks from each project using cookie API
  for (const project of projects) {
    try {
      const res = await fetch(`https://api.ticktick.com/api/v2/project/${project.id}/completed`, { 
        headers: cookieHeaders 
      });
      if (res.ok) {
        const completed = await res.json();
        if (Array.isArray(completed)) {
          allCompleted = allCompleted.concat(completed);
        }
      }
    } catch (e) {
      // Some projects may not be accessible
    }
  }

  // Filter by completedTime to get only recent ones
  const recentlyCompleted = allCompleted.filter(task => {
    if (!task.completedTime) return false;
    const completedAt = new Date(task.completedTime);
    return completedAt >= startTime;
  });

  return recentlyCompleted;
}

/**
 * Create a new project (list)
 */
export async function createProject(name, color = '#4772FA') {
  return ticktickRequest('/project', {
    method: 'POST',
    body: JSON.stringify({
      name: name,
      color: color,
      viewMode: 'list',
      kind: 'TASK'
    })
  });
}

/**
 * Find project by name
 */
export async function findProjectByName(name) {
  const projects = await getProjects();
  return projects.find(p => p.name.toLowerCase() === name.toLowerCase());
}

/**
 * Get or create project by name
 */
export async function getOrCreateProject(name) {
  let project = await findProjectByName(name);
  if (!project) {
    console.log(`📁 Creating new project: ${name}`);
    project = await createProject(name);
  }
  return project;
}

export default {
  getProjects,
  getAllTasks,
  getNotionSyncedTasks,      // EFFICIENT: Filter by notion-sync tag (open tasks)
  getCompletedNotionTasks,   // EFFICIENT: Filter by notion-sync tag (completed)
  createTask,
  updateTask,
  moveTask,
  completeTask,
  deleteTask,
  getCompletedTasks,         // OLD: Cookie API (kept for backup)
  createProject,
  findProjectByName,
  getOrCreateProject,
  getInboxId,
  NOTION_SYNC_TAG,
  headers
};
