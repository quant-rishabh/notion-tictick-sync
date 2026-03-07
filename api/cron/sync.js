/**
 * Cron Job: Full Two-Way Sync
 *
 * Runs every 5 minutes (configured in vercel.json)
 *
 * 1. Forward Sync: Notion -> TickTick (create/update/delete)
 * 2. Reverse Sync: TickTick completions -> Notion checkboxes
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TICKTICK_BEARER_TOKEN = process.env.TICKTICK_BEARER_TOKEN;
const TICKTICK_USER_ID = process.env.TICKTICK_USER_ID;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;
const TICKTICK_COOKIE_TOKEN = process.env.TICKTICK_COOKIE_TOKEN;

const NOTION_API_BASE = 'https://api.notion.com/v1';
const TICKTICK_API_BASE = 'https://api.ticktick.com/open/v1';
const NOTION_SYNC_TAG = 'notion-sync';

// ==================== NOTION API ====================

async function notionRequest(endpoint, options = {}) {
  const response = await fetch(`${NOTION_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  return response.json();
}

async function getAllBlocks(blockId) {
  let allBlocks = [];
  let hasMore = true;
  let startCursor = null;

  while (hasMore) {
    let endpoint = `/blocks/${blockId}/children?page_size=100`;
    if (startCursor) endpoint += `&start_cursor=${startCursor}`;

    const response = await notionRequest(endpoint);
    allBlocks = allBlocks.concat(response.results || []);
    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }

  return allBlocks;
}

async function getAllTodosFlat(blockId, maxDepth = 5) {
  const allTodos = [];

  async function fetchRecursive(parentId, depth) {
    if (depth > maxDepth) return;

    const blocks = await getAllBlocks(parentId);
    const todos = blocks.filter(b => b.type === 'to_do');

    for (const todo of todos) {
      allTodos.push(todo);
      if (todo.has_children) {
        await fetchRecursive(todo.id, depth + 1);
      }
    }
  }

  await fetchRecursive(blockId, 1);
  return allTodos;
}

async function setTodoChecked(blockId, checked) {
  return notionRequest(`/blocks/${blockId}`, {
    method: 'PATCH',
    body: JSON.stringify({ to_do: { checked } })
  });
}

async function deleteBlock(blockId) {
  return notionRequest(`/blocks/${blockId}`, {
    method: 'DELETE'
  });
}

async function getBlock(blockId) {
  return notionRequest(`/blocks/${blockId}`);
}

// ==================== TICKTICK API ====================

async function ticktickRequest(endpoint, options = {}) {
  const response = await fetch(`${TICKTICK_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${TICKTICK_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// Get all tasks with notion-sync tag
async function getNotionSyncedTasks(statusFilter = [0]) {
  const projects = await ticktickRequest('/project');
  let allTasks = [];

  const inboxId = `inbox${TICKTICK_USER_ID}`;
  const projectIds = [...(projects || []).map(p => p.id), inboxId];

  for (const projectId of projectIds) {
    try {
      const data = await ticktickRequest(`/project/${projectId}/data`);
      if (data && data.tasks) {
        allTasks = allTasks.concat(data.tasks);
      }
    } catch (e) {
      // Skip failed projects
    }
  }

  // Filter by notion-sync tag and status
  return allTasks.filter(t => {
    const hasTag = t.tags && t.tags.includes(NOTION_SYNC_TAG);
    const matchesStatus = statusFilter.includes(t.status);
    return hasTag && matchesStatus;
  });
}

// Get completed tasks using Cookie API (more reliable for completed)
async function getCompletedNotionTasks() {
  if (!TICKTICK_COOKIE_TOKEN) {
    console.log('Cookie token not set, using Open API for completed tasks');
    // Fallback: use status=2 from Open API (may not include all completed)
    return getNotionSyncedTasks([2]);
  }

  try {
    const projRes = await fetch('https://api.ticktick.com/api/v2/projects', {
      headers: { 'Cookie': `t=${TICKTICK_COOKIE_TOKEN}` }
    });
    
    if (!projRes.ok) {
      console.log('Cookie expired, using Open API fallback');
      return getNotionSyncedTasks([2]);
    }

    const projects = await projRes.json();
    const inboxId = `inbox${TICKTICK_USER_ID}`;
    projects.push({ id: inboxId });

    let allCompleted = [];

    for (const project of projects) {
      try {
        const res = await fetch(`https://api.ticktick.com/api/v2/project/${project.id}/completed`, {
          headers: { 'Cookie': `t=${TICKTICK_COOKIE_TOKEN}` }
        });
        if (res.ok) {
          const completed = await res.json();
          if (Array.isArray(completed)) {
            allCompleted = allCompleted.concat(completed);
          }
        }
      } catch (e) {}
    }

    return allCompleted.filter(t => t.tags && t.tags.includes(NOTION_SYNC_TAG));
  } catch (e) {
    console.error('Error fetching completed tasks:', e.message);
    return getNotionSyncedTasks([2]);
  }
}

async function createTask(taskData) {
  const tags = taskData.tags || [];
  if (!tags.includes(NOTION_SYNC_TAG)) {
    tags.push(NOTION_SYNC_TAG);
  }

  return ticktickRequest('/task', {
    method: 'POST',
    body: JSON.stringify({
      title: taskData.title,
      content: taskData.content || '',
      projectId: `inbox${TICKTICK_USER_ID}`,
      tags: tags,
      priority: taskData.priority || 0,
      ...(taskData.dueDate && { dueDate: taskData.dueDate })
    })
  });
}

async function updateTask(taskData) {
  return ticktickRequest(`/task/${taskData.id}`, {
    method: 'POST',
    body: JSON.stringify(taskData)
  });
}

async function deleteTask(taskId, projectId) {
  return ticktickRequest(`/project/${projectId}/task/${taskId}`, {
    method: 'DELETE'
  });
}

// ==================== PARSER ====================

function parseTask(text) {
  let title = text;
  const tags = [];
  let priority = 0;
  let dueDate = null;

  const tagMatches = title.match(/#(\w+)/g);
  if (tagMatches) {
    tagMatches.forEach(tag => {
      const tagName = tag.slice(1);
      if (!['track', 'notrack'].includes(tagName)) {
        tags.push(tagName);
      }
    });
    title = title.replace(/#\w+/g, '').trim();
  }

  const priorityMatch = title.match(/!([1-3])/);
  if (priorityMatch) {
    priority = parseInt(priorityMatch[1]);
    title = title.replace(/![1-3]/g, '').trim();
  }

  const dateMatch = title.match(/\$(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    dueDate = dateMatch[1];
    title = title.replace(/\$\d{4}-\d{2}-\d{2}/g, '').trim();
  }

  title = title.replace(/\s+/g, ' ').trim();

  return { title, tags, priority, dueDate };
}

// ==================== MAIN SYNC ====================

export default async function handler(req, res) {
  console.log('Running full two-way sync...');

  if (!NOTION_TOKEN || !TICKTICK_BEARER_TOKEN || !NOTION_PAGE_ID) {
    return res.status(500).json({
      error: 'Missing environment variables',
      required: ['NOTION_TOKEN', 'TICKTICK_BEARER_TOKEN', 'NOTION_PAGE_ID']
    });
  }

  try {
    const result = await runFullSync();
    return res.status(200).json({
      ok: true,
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Sync error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function runFullSync() {
  const stats = {
    forward: { created: 0, updated: 0, deleted: 0, skipped: 0 },
    reverse: { checked: 0, deleted: 0, skipped: 0, errors: 0 }
  };

  // ==================== FORWARD SYNC: Notion -> TickTick ====================
  console.log('\n=== FORWARD SYNC: Notion -> TickTick ===\n');

  const todos = await getAllTodosFlat(NOTION_PAGE_ID);
  console.log(`Found ${todos.length} todos in Notion`);

  const syncedTasks = await getNotionSyncedTasks([0]);
  console.log(`Found ${syncedTasks.length} synced tasks in TickTick`);

  // Build lookup map
  const ticktickByNotionId = new Map();
  const duplicates = [];

  syncedTasks.forEach(t => {
    const match = t.content ? t.content.match(/notion:([a-f0-9-]+)/) : null;
    if (match) {
      const notionId = match[1];
      if (ticktickByNotionId.has(notionId)) {
        duplicates.push(t);
      } else {
        ticktickByNotionId.set(notionId, t);
      }
    }
  });

  // Delete duplicates
  for (const dup of duplicates) {
    console.log(`Deleting duplicate: "${dup.title}"`);
    try {
      await deleteTask(dup.id, dup.projectId);
      stats.forward.deleted++;
    } catch (e) {}
  }

  // Delete tasks not in Notion
  for (const [notionId, task] of ticktickByNotionId) {
    const exists = todos.find(b => b.id === notionId);
    if (!exists) {
      console.log(`Deleting orphan: "${task.title}"`);
      try {
        await deleteTask(task.id, task.projectId);
        stats.forward.deleted++;
      } catch (e) {}
    }
  }

  // Create/Update tasks
  for (const block of todos) {
    const rawText = block.to_do.rich_text.map(r => r.plain_text).join('');
    const isChecked = block.to_do.checked;

    if (!rawText.trim() || isChecked) {
      stats.forward.skipped++;
      continue;
    }

    const existingTask = ticktickByNotionId.get(block.id);
    const parsed = parseTask(rawText);

    if (existingTask) {
      const existingTags = (existingTask.tags || []).filter(t => t !== NOTION_SYNC_TAG).sort().join(',');
      const newTags = (parsed.tags || []).sort().join(',');

      if (existingTask.title !== parsed.title || existingTags !== newTags) {
        console.log(`Updating: "${parsed.title}"`);
        const tags = [...(parsed.tags || [])];
        if (!tags.includes(NOTION_SYNC_TAG)) tags.push(NOTION_SYNC_TAG);

        try {
          await updateTask({
            id: existingTask.id,
            projectId: existingTask.projectId,
            title: parsed.title,
            content: existingTask.content,
            tags: tags,
            priority: parsed.priority || 0
          });
          stats.forward.updated++;
        } catch (e) {}
      } else {
        stats.forward.skipped++;
      }
    } else {
      console.log(`Creating: "${parsed.title}"`);
      try {
        await createTask({
          title: parsed.title,
          content: `notion:${block.id}`,
          tags: parsed.tags || [],
          priority: parsed.priority || 0,
          dueDate: parsed.dueDate
        });
        stats.forward.created++;
      } catch (e) {}
    }
  }

  // ==================== REVERSE SYNC: TickTick -> Notion ====================
  console.log('\n=== REVERSE SYNC: TickTick -> Notion ===\n');

  const completedTasks = await getCompletedNotionTasks();
  console.log(`Found ${completedTasks.length} completed tasks with notion-sync tag`);

  for (const task of completedTasks) {
    const match = task.content ? task.content.match(/notion:([a-f0-9-]+)/) : null;
    if (!match) continue;

    const notionBlockId = match[1];

    // Skip recurring tasks (they auto-recreate)
    if (task.repeatFlag) {
      console.log(`Skipping recurring: "${task.title}"`);
      stats.reverse.skipped++;
      continue;
    }

    try {
      const block = await getBlock(notionBlockId);
      
      if (block.object === 'error') {
        console.log(`Block not found: ${notionBlockId}`);
        stats.reverse.errors++;
        continue;
      }

      if (block.to_do && !block.to_do.checked) {
        console.log(`Checking in Notion: "${task.title}"`);
        await setTodoChecked(notionBlockId, true);
        stats.reverse.checked++;
      } else {
        stats.reverse.skipped++;
      }
    } catch (e) {
      console.error(`Failed to check: ${e.message}`);
      stats.reverse.errors++;
    }
  }

  console.log('\n=== Sync Complete ===');
  console.log(`Forward: ${stats.forward.created} created, ${stats.forward.updated} updated, ${stats.forward.deleted} deleted`);
  console.log(`Reverse: ${stats.reverse.checked} checked in Notion`);

  return stats;
}

export const config = {
  maxDuration: 60
};
