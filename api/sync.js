/**
 * Manual Sync Endpoint
 * 
 * Call this to manually trigger sync in both directions.
 * Useful for testing or manual sync button.
 * 
 * GET /api/sync - Sync both directions
 * GET /api/sync?direction=notion - Sync Notion → TickTick only
 * GET /api/sync?direction=ticktick - Sync TickTick → Notion only
 */

import { parseTask } from '../lib/parser.js';

// Environment variables
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TICKTICK_TOKEN = process.env.TICKTICK_TOKEN;
const TICKTICK_CSRF = process.env.TICKTICK_CSRF;
const TRACKED_PAGES = (process.env.TRACKED_PAGES || '').split(',').filter(Boolean);

const NOTION_API_BASE = 'https://api.notion.com/v1';
const TICKTICK_API_BASE = 'https://api.ticktick.com/api/v2';

// ----- API Helpers -----

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

async function ticktickRequest(endpoint, options = {}) {
  const response = await fetch(`${TICKTICK_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `t=${TICKTICK_TOKEN}`,
      'x-csrftoken': TICKTICK_CSRF,
      'x-tz': 'Asia/Calcutta',
      ...options.headers
    }
  });
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// ----- Notion Helpers -----

async function getBlockChildren(blockId) {
  return notionRequest(`/blocks/${blockId}/children?page_size=100`);
}

async function setTodoChecked(blockId, checked) {
  return notionRequest(`/blocks/${blockId}`, {
    method: 'PATCH',
    body: JSON.stringify({ to_do: { checked } })
  });
}

// ----- TickTick Helpers -----

async function getProjects() {
  return ticktickRequest('/projects');
}

async function findProjectByName(name) {
  const projects = await getProjects();
  return projects.find(p => p.name.toLowerCase() === name.toLowerCase());
}

async function createProject(name) {
  return ticktickRequest('/project', {
    method: 'POST',
    body: JSON.stringify({ name, color: '#4772FA', viewMode: 'list', kind: 'TASK' })
  });
}

async function getOrCreateProject(name) {
  let project = await findProjectByName(name);
  if (!project) project = await createProject(name);
  return project;
}

function generateTaskId() {
  const chars = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function createTickTickTask(task) {
  const taskId = generateTaskId();
  const taskData = {
    id: taskId,
    title: task.title,
    projectId: task.projectId || null,
    content: task.content || '',
    priority: task.priority || 0,
    status: 0,
    timeZone: 'Asia/Calcutta',
    isAllDay: true,
    kind: 'TEXT'
  };
  
  if (task.dueDate) taskData.dueDate = task.dueDate;
  if (task.repeatFlag) taskData.repeatFlag = task.repeatFlag;

  await ticktickRequest('/task', {
    method: 'POST',
    body: JSON.stringify(taskData)
  });

  return { id: taskId, ...taskData };
}

async function getRecentlyCompletedTasks(minutesAgo = 10) {
  const now = new Date();
  const startTime = new Date(now.getTime() - minutesAgo * 60 * 1000);
  
  // Get all projects
  const projects = await getProjects();
  let allCompleted = [];
  
  // Fetch completed tasks from each project
  for (const project of projects) {
    try {
      const completed = await ticktickRequest(`/project/${project.id}/completed`);
      if (Array.isArray(completed)) {
        allCompleted = allCompleted.concat(completed);
      }
    } catch (e) {}
  }
  
  // Filter by completedTime to get only recent ones
  return allCompleted.filter(task => {
    if (!task.completedTime) return false;
    const completedAt = new Date(task.completedTime);
    return completedAt >= startTime;
  });
}

async function getAllSyncedNotionIds() {
  // Get all tasks to find which Notion IDs are already synced
  const projects = await getProjects();
  const syncedIds = new Set();
  
  for (const project of projects) {
    try {
      const tasks = await ticktickRequest(`/project/${project.id}/tasks`);
      if (Array.isArray(tasks)) {
        tasks.forEach(t => {
          const match = t.content?.match(/notion:([a-f0-9-]+)/);
          if (match) syncedIds.add(match[1]);
        });
      }
    } catch (e) {}
  }
  
  return syncedIds;
}

// ----- Sync Functions -----

async function syncNotionToTickTick(pageId) {
  let created = 0, skipped = 0;
  
  // Get existing synced Notion IDs
  const syncedNotionIds = await getAllSyncedNotionIds();
  
  // Recursively get all tasks from page
  async function processPage(blockId) {
    const response = await getBlockChildren(blockId);
    const blocks = response.results || [];
    
    for (const block of blocks) {
      if (block.type === 'to_do') {
        const rawText = block.to_do.rich_text.map(r => r.plain_text).join('');
        const isChecked = block.to_do.checked;
        
        if (!rawText.trim() || isChecked) {
          skipped++;
          continue;
        }
        
        if (syncedNotionIds.has(block.id)) {
          skipped++;
          continue;
        }
        
        // Parse and create
        const parsed = parseTask(rawText);
        let projectId = null;
        
        if (parsed.project) {
          const project = await getOrCreateProject(parsed.project);
          projectId = project.id;
        }
        
        await createTickTickTask({
          title: parsed.title,
          projectId,
          content: `notion:${block.id}`,
          priority: parsed.priority,
          dueDate: parsed.dueDate,
          repeatFlag: parsed.repeatFlag
        });
        
        created++;
      }
      
      if (block.type === 'child_page' || block.has_children) {
        await processPage(block.id);
      }
    }
  }
  
  await processPage(pageId);
  return { created, skipped };
}

async function syncTickTickToNotion() {
  let checked = 0, errors = 0;
  
  // OPTIMIZED: Get only recently completed (last 10 min for manual sync)
  const recentlyCompleted = await getRecentlyCompletedTasks(10);
  
  if (!recentlyCompleted || !Array.isArray(recentlyCompleted)) {
    return { checked: 0, errors: 0, message: 'No recent completions' };
  }
  
  // Filter ones with notion: in content
  const fromNotion = recentlyCompleted.filter(t => 
    t.content?.includes('notion:')
  );
  
  for (const task of fromNotion) {
    const match = task.content.match(/notion:([a-f0-9-]+)/);
    if (!match) continue;
    
    try {
      await setTodoChecked(match[1], true);
      checked++;
    } catch (e) {
      errors++;
    }
  }
  
  return { checked, errors, recentTasksFound: recentlyCompleted.length };
}

// ----- Handler -----

export default async function handler(req, res) {
  const direction = req.query.direction || 'both';
  const pageId = req.query.pageId || TRACKED_PAGES[0];
  
  const results = {
    direction,
    timestamp: new Date().toISOString()
  };
  
  try {
    if (direction === 'notion' || direction === 'both') {
      if (!pageId) {
        return res.status(400).json({ error: 'No pageId provided and TRACKED_PAGES not set' });
      }
      results.notionToTickTick = await syncNotionToTickTick(pageId);
    }
    
    if (direction === 'ticktick' || direction === 'both') {
      results.tickTickToNotion = await syncTickTickToNotion();
    }
    
    return res.status(200).json({ ok: true, ...results });
    
  } catch (error) {
    console.error('Sync error:', error);
    return res.status(500).json({ error: error.message });
  }
}
