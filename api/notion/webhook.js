/**
 * Notion Webhook Handler
 *
 * Receives real-time updates from Notion when blocks are changed.
 * More efficient than polling - syncs only the changed blocks.
 *
 * Flow:
 * 1. CREATE: Block exists in Notion, not in TickTick -> Create task
 * 2. UPDATE: Block exists in Notion, exists in TickTick -> Update task
 * 3. DELETE: Block returns 404 from Notion -> Delete from TickTick
 * 4. CHECK (one-time): Block checked:true -> COMPLETE in TickTick
 * 5. CHECK (recurring): Block checked:true -> DELETE from TickTick (stops forever)
 *
 * Uses TickTick Search API for O(1) lookup by block ID
 * 
 * @list: FEATURE (v2.0):
 * - Add @list:project-name as first line of Notion page
 * - Tasks will be created in matching TickTick project
 * - Supports: dash-to-space (@list:my-project → "my project")
 * - Supports: fuzzy matching (70% threshold for typos)
 * - Supports: auto-create project if not exists
 * - Supports: auto-migrate existing tasks when @list added
 */

import { parseTask } from '../../lib/ai-parser.js';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TICKTICK_BEARER_TOKEN = process.env.TICKTICK_BEARER_TOKEN;
const TICKTICK_COOKIE_TOKEN = process.env.TICKTICK_COOKIE_TOKEN;
const TICKTICK_USER_ID = process.env.TICKTICK_USER_ID;

const NOTION_API_BASE = 'https://api.notion.com/v1';
const TICKTICK_API_BASE = 'https://api.ticktick.com/open/v1';
const NOTION_SYNC_TAG = 'notion-sync';
const NOTION_RECURRING_TAG = 'notion-recurring';
const MAX_MIGRATE_TASKS = 50; // Safety limit for migration

// ==================== WEBHOOK DEDUPLICATION ====================
// Track processed webhook IDs to prevent duplicate processing on retries
// Uses in-memory cache (cleared on cold start, but that's fine - better than duplicates)
const processedWebhooks = new Map(); // webhookId -> timestamp
const WEBHOOK_CACHE_TTL = 60 * 1000; // 60 seconds - Notion retries within this window

function isWebhookAlreadyProcessed(webhookId) {
  const processed = processedWebhooks.get(webhookId);
  if (processed) {
    const age = Date.now() - processed;
    if (age < WEBHOOK_CACHE_TTL) {
      return true; // Already processed recently
    }
    // Expired, remove it
    processedWebhooks.delete(webhookId);
  }
  return false;
}

function markWebhookProcessed(webhookId) {
  processedWebhooks.set(webhookId, Date.now());
  
  // Cleanup old entries (keep cache small)
  if (processedWebhooks.size > 100) {
    const now = Date.now();
    for (const [id, timestamp] of processedWebhooks) {
      if (now - timestamp > WEBHOOK_CACHE_TTL) {
        processedWebhooks.delete(id);
      }
    }
  }
}

// ==================== FUZZY MATCHING & HELPERS ====================

/**
 * Calculate similarity between two strings (0.0 to 1.0)
 * Uses Levenshtein distance
 */
function similarity(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;
  
  const matrix = [];
  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  
  const maxLen = Math.max(s1.length, s2.length);
  return 1 - matrix[s1.length][s2.length] / maxLen;
}

/**
 * Normalize list name: dash/underscore → space, lowercase
 * @list:linkedin-social-media → "linkedin social media"
 */
function normalizeListName(name) {
  return name.replace(/[-_]/g, ' ').toLowerCase().trim();
}

/**
 * Extract @list:xxx from text
 * Returns the list name or null
 */
function extractListDirective(text) {
  const match = text.match(/@list:([\w-]+)/i);
  if (match) {
    console.log(`[LIST-DEBUG] extractListDirective: Found "@list:${match[1]}" in text: "${text.substring(0, 50)}..."`);
  }
  return match ? match[1] : null;
}

/**
 * Get first few blocks of a Notion page
 */
async function getPageFirstBlocks(pageId, limit = 5) {
  console.log(`[LIST-DEBUG] getPageFirstBlocks: Fetching first ${limit} blocks of page ${pageId}`);
  const { data, status } = await notionRequest(`/blocks/${pageId}/children?page_size=${limit}`);
  if (status !== 200 || !data.results) {
    console.log(`[LIST-DEBUG] getPageFirstBlocks: FAILED - status=${status}, data=${JSON.stringify(data)}`);
    return [];
  }
  console.log(`[LIST-DEBUG] getPageFirstBlocks: Got ${data.results.length} blocks`);
  // Log block types for debugging
  data.results.forEach((b, i) => {
    const text = b[b.type]?.rich_text?.map(r => r.plain_text).join('') || '';
    console.log(`[LIST-DEBUG]   Block ${i}: type=${b.type}, text="${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
  });
  return data.results;
}

/**
 * Find @list: directive from page's first block
 */
async function findListDirective(pageId) {
  console.log(`[LIST-DEBUG] findListDirective: Searching for @list: in page ${pageId}`);
  const blocks = await getPageFirstBlocks(pageId, 3);
  
  if (blocks.length === 0) {
    console.log(`[LIST-DEBUG] findListDirective: No blocks found in page`);
    return null;
  }
  
  for (const block of blocks) {
    console.log(`[LIST-DEBUG] findListDirective: Checking block type=${block.type}`);
    if (block.type === 'paragraph' && block.paragraph?.rich_text) {
      const text = block.paragraph.rich_text.map(r => r.plain_text).join('');
      console.log(`[LIST-DEBUG] findListDirective: Paragraph text="${text}"`);
      const listName = extractListDirective(text);
      if (listName) {
        console.log(`[LIST] ✓ Found @list:${listName} in page ${pageId}`);
        return { listName, blockId: block.id };
      }
    } else {
      console.log(`[LIST-DEBUG] findListDirective: Skipping block - not a paragraph or no rich_text`);
    }
  }
  
  console.log(`[LIST-DEBUG] findListDirective: No @list: directive found in first 3 blocks`);
  return null;
}

// Cache for TickTick projects (refreshed per webhook)
let cachedProjects = null;

/**
 * Get all TickTick projects (cached per request)
 */
async function getTickTickProjects(forceRefresh = false) {
  if (cachedProjects && !forceRefresh) {
    return cachedProjects;
  }
  cachedProjects = await ticktickRequest('/project') || [];
  return cachedProjects;
}

/**
 * Find TickTick project by name (supports fuzzy matching)
 */
async function findProjectByName(listName) {
  console.log(`[LIST-DEBUG] findProjectByName: Looking for project matching "${listName}"`);
  const projects = await getTickTickProjects();
  const normalized = normalizeListName(listName);
  console.log(`[LIST-DEBUG] findProjectByName: Normalized name="${normalized}", checking ${projects.length} projects`);
  
  // Log all project names for debugging
  console.log(`[LIST-DEBUG] findProjectByName: Available projects: [${projects.map(p => `"${p.name}"`).join(', ')}]`);
  
  // 1. Try exact match first
  const exact = projects.find(p => p.name.toLowerCase() === normalized);
  if (exact) {
    console.log(`[LIST] ✓ Exact match: "${listName}" → "${exact.name}" (ID: ${exact.id})`);
    return exact;
  }
  console.log(`[LIST-DEBUG] findProjectByName: No exact match, trying fuzzy...`);
  
  // 2. Try fuzzy match (70% threshold)
  let bestMatch = null;
  let bestScore = 0;
  
  for (const project of projects) {
    const score = similarity(normalized, project.name.toLowerCase());
    console.log(`[LIST-DEBUG]   Fuzzy: "${normalized}" vs "${project.name.toLowerCase()}" = ${Math.round(score * 100)}%`);
    if (score > bestScore && score >= 0.7) {
      bestMatch = project;
      bestScore = score;
    }
  }
  
  if (bestMatch) {
    console.log(`[LIST] ✓ Fuzzy match: "${listName}" → "${bestMatch.name}" (${Math.round(bestScore * 100)}%)`);
    return bestMatch;
  }
  
  console.log(`[LIST] ✗ No match found for "${listName}" (will create new project)`);
  return null;
}

/**
 * Create a new TickTick project
 */
async function createProject(name) {
  console.log(`[LIST] Creating new project: "${name}"`);
  const result = await ticktickRequest('/project', {
    method: 'POST',
    body: JSON.stringify({
      name: name,
      viewMode: 'list',
      kind: 'TASK'
    })
  });
  
  if (result && result.id) {
    console.log(`[LIST] ✓ Created project: "${result.name}" (ID: ${result.id})`);
    // Refresh cache
    cachedProjects = null;
    return result;
  }
  
  console.log(`[LIST] ✗ Failed to create project`);
  return null;
}

/**
 * Get or create TickTick project by name
 */
async function getOrCreateProject(listName) {
  console.log(`[LIST-DEBUG] getOrCreateProject: Getting/creating project for "${listName}"`);
  
  // First try to find existing project
  let project = await findProjectByName(listName);
  
  if (project) {
    console.log(`[LIST-DEBUG] getOrCreateProject: Found existing project, ID=${project.id}`);
    return project.id;
  }
  
  // Create new project with normalized name
  const normalizedName = normalizeListName(listName)
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' '); // Title case
  
  console.log(`[LIST-DEBUG] getOrCreateProject: Creating new project with name="${normalizedName}"`);
  const newProject = await createProject(normalizedName);
  
  if (newProject) {
    console.log(`[LIST-DEBUG] getOrCreateProject: ✓ Created new project, ID=${newProject.id}`);
  } else {
    console.log(`[LIST-DEBUG] getOrCreateProject: ✗ Failed to create project`);
  }
  
  return newProject ? newProject.id : null;
}

/**
 * Find all TickTick tasks from a specific Notion page
 */
async function findTasksByNotionPageId(pageId) {
  const tasks = [];
  
  // Method 1: Try Search API (faster)
  if (TICKTICK_COOKIE_TOKEN) {
    try {
      // Search for tasks containing this page ID in content
      const searchUrl = `https://api.ticktick.com/api/v2/search/all?keywords=notion.so/${pageId.replace(/-/g, '')}`;
      const response = await fetch(searchUrl, {
        headers: { 'Cookie': `t=${TICKTICK_COOKIE_TOKEN}` }
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.tasks) {
          console.log(`[MIGRATE] Found ${data.tasks.length} tasks via Search API`);
          return data.tasks;
        }
      }
    } catch (e) {
      console.log(`[MIGRATE] Search API failed, using Open API`);
    }
  }
  
  // Method 2: Fallback - scan all projects
  const projects = await getTickTickProjects();
  const inboxId = `inbox${TICKTICK_USER_ID}`;
  const projectIds = [...projects.map(p => p.id), inboxId];
  
  for (const projectId of projectIds) {
    try {
      const data = await ticktickRequest(`/project/${projectId}/data`);
      if (data && data.tasks) {
        for (const task of data.tasks) {
          // Check if task content contains this page ID
          if (task.content && task.content.includes(pageId.replace(/-/g, ''))) {
            tasks.push(task);
          }
        }
      }
    } catch (e) {
      // Skip failed projects
    }
  }
  
  console.log(`[MIGRATE] Found ${tasks.length} tasks via Open API`);
  return tasks;
}

/**
 * Migrate tasks to a new project (uses batch API for efficiency)
 */
async function migrateTasksToProject(tasks, newProjectId, newProjectName) {
  const toMigrate = tasks.slice(0, MAX_MIGRATE_TASKS);
  
  if (tasks.length > MAX_MIGRATE_TASKS) {
    console.log(`[MIGRATE] ⚠️ Only migrating first ${MAX_MIGRATE_TASKS} of ${tasks.length} tasks`);
  }

  // Use batch move API (1 request instead of N)
  const result = await batchMoveTasks(toMigrate, newProjectId);
  
  console.log(`[MIGRATE] Batch move result: ${result.moved} moved, ${result.skipped || 0} skipped, ${result.errors || 0} errors`);
  
  return { 
    migrated: result.moved, 
    failed: result.errors || 0, 
    skipped: (result.skipped || 0) + (tasks.length - toMigrate.length)
  };
}

/**
 * Get target project ID for a page (main function)
 * Returns projectId or inbox if not specified
 */
async function getTargetProjectId(pageId) {
  console.log(`\n[LIST-DEBUG] ========== getTargetProjectId START ==========`);
  console.log(`[LIST-DEBUG] pageId: ${pageId}`);
  
  if (!pageId) {
    console.log(`[LIST-DEBUG] No pageId provided, using Inbox`);
    console.log(`[LIST-DEBUG] ========== getTargetProjectId END ==========\n`);
    return `inbox${TICKTICK_USER_ID}`;
  }
  
  const directive = await findListDirective(pageId);
  
  if (!directive) {
    console.log(`[LIST] No @list: directive found, using Inbox`);
    console.log(`[LIST-DEBUG] ========== getTargetProjectId END (no directive) ==========\n`);
    return `inbox${TICKTICK_USER_ID}`;
  }
  
  console.log(`[LIST-DEBUG] Found directive: @list:${directive.listName}`);
  const projectId = await getOrCreateProject(directive.listName);
  
  if (projectId) {
    console.log(`[LIST] ✓ Target project resolved: ${projectId}`);
    console.log(`[LIST-DEBUG] ========== getTargetProjectId END (success) ==========\n`);
    return projectId;
  }
  
  console.log(`[LIST] Failed to get/create project, using Inbox`);
  console.log(`[LIST-DEBUG] ========== getTargetProjectId END (fallback) ==========\n`);
  return `inbox${TICKTICK_USER_ID}`;
}

// ==================== API HELPERS ====================

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
  return { data: await response.json(), status: response.status };
}

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

async function getBlock(blockId) {
  return notionRequest(`/blocks/${blockId}`);
}

// ==================== TICKTICK SEARCH (Fast O(1) lookup) ====================

async function findTickTickTaskByNotionId(notionBlockId) {
  // Search API only - no fallback to avoid rate limits
  if (!TICKTICK_COOKIE_TOKEN) {
    console.log(`   ⚠️ TICKTICK_COOKIE_TOKEN not set - cannot search for existing tasks`);
    console.log(`   ⚠️ Task will be created (may cause duplicates if task exists)`);
    return null;
  }

  try {
    const searchUrl = `https://api.ticktick.com/api/v2/search/all?keywords=notion:${notionBlockId}`;
    const response = await fetch(searchUrl, {
      headers: {
        'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`
      }
    });

    // Check for expired/invalid token
    if (response.status === 401 || response.status === 403) {
      console.log(`   ❌ TICKTICK_COOKIE_TOKEN expired or invalid (status: ${response.status})`);
      console.log(`   ❌ Please refresh your cookie token in environment variables`);
      return null;
    }

    if (!response.ok) {
      console.log(`   ⚠️ Search API returned status ${response.status}`);
      return null;
    }

    const data = await response.json();

    // Check for error response (another sign of expired token)
    if (data.errorCode || data.errorMessage) {
      console.log(`   ❌ Search API error: ${data.errorCode} - ${data.errorMessage}`);
      if (data.errorCode === 'invalid_token' || data.errorCode === 'token_expired') {
        console.log(`   ❌ TICKTICK_COOKIE_TOKEN is expired - please refresh it`);
      }
      return null;
    }

    // Valid response - check for tasks
    if (data.tasks && data.tasks.length > 0) {
      console.log(`   ✓ Found via Search API`);
      return data.tasks[0];
    }

    // No tasks found - this is normal for new tasks
    console.log(`   ✓ Search complete - no existing task`);
    return null;

  } catch (e) {
    console.log(`   ⚠️ Search API error: ${e.message}`);
    return null;
  }
}

// ==================== TICKTICK OPERATIONS ====================

async function createTask(taskData, projectId = null) {
  const tags = taskData.tags || [];

  // Use different tag for recurring vs one-time tasks
  const syncTag = taskData.isRecurring ? NOTION_RECURRING_TAG : NOTION_SYNC_TAG;
  if (!tags.includes(syncTag)) {
    tags.push(syncTag);
  }

  const body = {
    title: taskData.title,
    content: taskData.content || '',
    projectId: projectId || `inbox${TICKTICK_USER_ID}`,
    tags: tags,
    priority: taskData.priority || 0,
  };

  // Add optional fields
  if (taskData.dueDate) body.dueDate = taskData.dueDate;
  if (taskData.startDate) body.startDate = taskData.startDate;
  if (taskData.repeatFlag) body.repeatFlag = taskData.repeatFlag;
  if (taskData.isAllDay !== undefined) body.isAllDay = taskData.isAllDay;
  if (taskData.reminders && taskData.reminders.length > 0) body.reminders = taskData.reminders;

  return ticktickRequest('/task', {
    method: 'POST',
    body: JSON.stringify(body)
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

// Complete task in TickTick (not delete!)
async function completeTask(taskId, projectId) {
  return ticktickRequest(`/project/${projectId}/task/${taskId}/complete`, {
    method: 'POST'
  });
}

// Batch delete multiple tasks at once (Cookie API - more efficient)
async function batchDeleteTasks(tasks) {
  if (!tasks || tasks.length === 0) return { success: true, deleted: 0 };
  
  if (!TICKTICK_COOKIE_TOKEN) {
    console.log(`[BATCH-DELETE] No TICKTICK_COOKIE_TOKEN, falling back to single deletes`);
    // Fallback to single deletes
    let deleted = 0;
    for (const task of tasks) {
      try {
        await deleteTask(task.id, task.projectId);
        deleted++;
      } catch (e) {
        console.log(`[BATCH-DELETE] Failed to delete ${task.id}: ${e.message}`);
      }
    }
    return { success: true, deleted };
  }

  try {
    const deletePayload = tasks.map(t => ({
      taskId: t.id,
      projectId: t.projectId
    }));

    const response = await fetch('https://api.ticktick.com/api/v2/batch/task', {
      method: 'POST',
      headers: {
        'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'x-tz': 'UTC'
      },
      body: JSON.stringify({
        add: [],
        update: [],
        delete: deletePayload,
        addAttachments: [],
        updateAttachments: [],
        deleteAttachments: []
      })
    });

    if (!response.ok) {
      console.log(`[BATCH-DELETE] API returned ${response.status}`);
      return { success: false, deleted: 0 };
    }

    const data = await response.json();
    console.log(`[BATCH-DELETE] ✓ Batch deleted ${tasks.length} tasks`);
    return { success: true, deleted: tasks.length, response: data };
  } catch (e) {
    console.log(`[BATCH-DELETE] Error: ${e.message}`);
    return { success: false, deleted: 0, error: e.message };
  }
}

// Batch move multiple tasks to a new project (Cookie API - more efficient)
async function batchMoveTasks(tasks, toProjectId) {
  if (!tasks || tasks.length === 0) return { success: true, moved: 0 };
  
  if (!TICKTICK_COOKIE_TOKEN) {
    console.log(`[BATCH-MOVE] No TICKTICK_COOKIE_TOKEN, falling back to single updates`);
    // Fallback to single updates
    let moved = 0;
    for (const task of tasks) {
      if (task.projectId === toProjectId) continue; // Skip if already in target
      try {
        await updateTask({
          id: task.id,
          projectId: toProjectId,
          title: task.title,
          content: task.content,
          tags: task.tags,
          priority: task.priority || 0
        });
        moved++;
      } catch (e) {
        console.log(`[BATCH-MOVE] Failed to move ${task.id}: ${e.message}`);
      }
    }
    return { success: true, moved };
  }

  try {
    // Filter out tasks already in target project
    const tasksToMove = tasks.filter(t => t.projectId !== toProjectId);
    
    if (tasksToMove.length === 0) {
      console.log(`[BATCH-MOVE] All tasks already in target project`);
      return { success: true, moved: 0, skipped: tasks.length };
    }

    const movePayload = tasksToMove.map(t => ({
      taskId: t.id,
      fromProjectId: t.projectId,
      toProjectId: toProjectId
    }));

    const response = await fetch('https://api.ticktick.com/api/v2/batch/taskProject', {
      method: 'POST',
      headers: {
        'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'x-tz': 'UTC'
      },
      body: JSON.stringify(movePayload)
    });

    if (!response.ok) {
      console.log(`[BATCH-MOVE] API returned ${response.status}`);
      return { success: false, moved: 0 };
    }

    const data = await response.json();
    const movedCount = Object.keys(data.id2etag || {}).length;
    const errorCount = Object.keys(data.id2error || {}).length;
    
    console.log(`[BATCH-MOVE] ✓ Batch moved ${movedCount} tasks (${errorCount} errors)`);
    return { 
      success: true, 
      moved: movedCount, 
      errors: errorCount,
      skipped: tasks.length - tasksToMove.length,
      response: data 
    };
  } catch (e) {
    console.log(`[BATCH-MOVE] Error: ${e.message}`);
    return { success: false, moved: 0, error: e.message };
  }
}

// ==================== SYNC SINGLE BLOCK ====================

function getNotionLink(pageId, blockId) {
  // Remove dashes from IDs for URL
  const cleanPageId = pageId.replace(/-/g, '');
  const cleanBlockId = blockId.replace(/-/g, '');
  return `https://notion.so/${cleanPageId}#${cleanBlockId}`;
}

async function syncBlock(blockId, pageId = '', targetProjectId = null) {
  console.log(`\n========== SYNC BLOCK: ${blockId} ==========`);
  console.log(`[SYNC] Target project: ${targetProjectId || 'not specified (will use Inbox)'}`);

  // 1. Get block from Notion
  console.log(`[NOTION] Fetching block...`);
  const { data: block, status } = await getBlock(blockId);
  console.log(`[NOTION] Response status: ${status}`);

  // 2. Fast lookup in TickTick
  console.log(`[TICKTICK] Searching for existing task...`);
  const existingTask = await findTickTickTaskByNotionId(blockId);
  if (existingTask) {
    console.log(`[TICKTICK] ✓ Found task: "${existingTask.title}" (ID: ${existingTask.id})`);
    console.log(`[TICKTICK]   Tags: [${(existingTask.tags || []).join(', ')}]`);
    console.log(`[TICKTICK]   Project: ${existingTask.projectId}`);
  } else {
    console.log(`[TICKTICK] ✗ No existing task found`);
  }

  // CASE 1: Block deleted from Notion (404)
  if (status === 404 || block.object === 'error') {
    console.log(`[NOTION] ⚠️ Block NOT FOUND (deleted or error)`);
    if (existingTask) {
      console.log(`[DELETE] 🗑️ Deleting from TickTick because block deleted from Notion`);
      console.log(`[DELETE]   Task: "${existingTask.title}"`);
      console.log(`[DELETE]   TickTick ID: ${existingTask.id}`);
      const deleteResult = await deleteTask(existingTask.id, existingTask.projectId);
      console.log(`[DELETE]   Result: ${deleteResult ? 'SUCCESS' : 'DONE'}`);
      return { action: 'deleted', reason: 'notion block deleted' };
    }
    console.log(`[SKIP] No task to delete`);
    return { action: 'skipped', reason: 'block not found, no task' };
  }

  // CASE 2: Not a todo block
  if (block.type !== 'to_do') {
    console.log(`[NOTION] Block type: ${block.type} (not a todo)`);
    if (existingTask) {
      console.log(`[DELETE] 🗑️ Block changed from todo to ${block.type}, deleting task`);
      console.log(`[DELETE]   Task: "${existingTask.title}"`);
      const deleteResult = await deleteTask(existingTask.id, existingTask.projectId);
      console.log(`[DELETE]   Result: ${deleteResult ? 'SUCCESS' : 'DONE'}`);
      return { action: 'deleted', reason: 'block type changed' };
    }
    console.log(`[SKIP] Not a todo block`);
    return { action: 'skipped', reason: 'not a todo' };
  }

  const rawText = block.to_do.rich_text.map(r => r.plain_text).join('');
  const isChecked = block.to_do.checked;
  console.log(`[NOTION] Todo text: "${rawText}"`);
  console.log(`[NOTION] Checked: ${isChecked}`);

  // CASE 3: Empty todo - delete from TickTick if exists
  if (!rawText.trim()) {
    console.log(`[NOTION] ⚠️ Todo text is EMPTY`);
    if (existingTask) {
      console.log(`[DELETE] 🗑️ Deleting empty task from TickTick`);
      console.log(`[DELETE]   Task: "${existingTask.title}"`);
      const deleteResult = await deleteTask(existingTask.id, existingTask.projectId);
      console.log(`[DELETE]   Result: ${deleteResult ? 'SUCCESS' : 'DONE'}`);
      return { action: 'deleted', reason: 'empty todo' };
    }
    console.log(`[SKIP] Empty todo, no task to delete`);
    return { action: 'skipped', reason: 'empty todo, no task' };
  }

  // CASE 4: Checked todo - Handle differently for recurring vs one-time
  if (isChecked) {
    console.log(`[NOTION] ✓ Todo is CHECKED`);
    if (existingTask) {
      // Check if it's a recurring task (has notion-recurring tag)
      const isRecurring = existingTask.tags && existingTask.tags.includes(NOTION_RECURRING_TAG);
      console.log(`[TICKTICK] Is recurring (has ${NOTION_RECURRING_TAG} tag): ${isRecurring}`);

      if (isRecurring) {
        // RECURRING: Delete task entirely to stop all future instances
        console.log(`[DELETE] 🔄🗑️ RECURRING task checked → DELETING to stop all future occurrences`);
        console.log(`[DELETE]   Task: "${existingTask.title}"`);
        const deleteResult = await deleteTask(existingTask.id, existingTask.projectId);
        console.log(`[DELETE]   Result: ${deleteResult ? 'SUCCESS' : 'DONE'}`);
        return { action: 'deleted', reason: 'recurring task stopped via Notion' };
      } else {
        // ONE-TIME: Just complete it
        console.log(`[COMPLETE] ✅ ONE-TIME task checked → Completing in TickTick`);
        console.log(`[COMPLETE]   Task: "${existingTask.title}"`);
        const completeResult = await completeTask(existingTask.id, existingTask.projectId);
        console.log(`[COMPLETE]   Result: ${completeResult ? 'SUCCESS' : 'DONE'}`);
        return { action: 'completed', reason: 'checked in notion' };
      }
    }
    console.log(`[SKIP] Checked todo but no task in TickTick`);
    return { action: 'skipped', reason: 'checked, no task' };
  }

  // CASE 5: Unchecked todo with text -> CREATE or UPDATE
  console.log(`[AI] Parsing task with AI...`);
  const parsed = await parseTask(rawText);
  console.log(`[AI] Parse result:`);
  console.log(`[AI]   Title: "${parsed.title}"`);
  console.log(`[AI]   Tags: [${(parsed.tags || []).join(', ')}]`);
  console.log(`[AI]   Priority: ${parsed.priority}`);
  console.log(`[AI]   Due Date: ${parsed.dueDate || 'none'}`);
  console.log(`[AI]   Is Recurring: ${parsed.isRecurring}`);
  console.log(`[AI]   Repeat Flag: ${parsed.repeatFlag || 'none'}`);
  console.log(`[AI]   Reminders: [${(parsed.reminders || []).join(', ')}]`);

  if (existingTask) {
    // UPDATE existing task
    const existingUserTags = (existingTask.tags || [])
      .filter(t => t !== NOTION_SYNC_TAG && t !== NOTION_RECURRING_TAG).sort().join(',');
    const newUserTags = (parsed.tags || []).sort().join(',');
    
    // Check if task needs to be moved to new project
    const needsProjectMove = targetProjectId && existingTask.projectId !== targetProjectId;

    console.log(`[UPDATE] Checking for changes...`);
    console.log(`[UPDATE]   Old title: "${existingTask.title}" → New: "${parsed.title}"`);
    console.log(`[UPDATE]   Old tags: [${existingUserTags}] → New: [${newUserTags}]`);
    console.log(`[UPDATE]   Old project: ${existingTask.projectId} → Target: ${targetProjectId || 'same'}`);
    console.log(`[UPDATE]   Needs project move: ${needsProjectMove}`);

    if (existingTask.title !== parsed.title || existingUserTags !== newUserTags || needsProjectMove) {
      console.log(`[UPDATE] 📝 Changes detected, updating task`);

      const syncTag = parsed.isRecurring ? NOTION_RECURRING_TAG : NOTION_SYNC_TAG;
      const updatedTags = [...(parsed.tags || [])];
      if (!updatedTags.includes(syncTag)) {
        updatedTags.push(syncTag);
      }

      const updateResult = await updateTask({
        id: existingTask.id,
        projectId: needsProjectMove ? targetProjectId : existingTask.projectId,
        title: parsed.title,
        content: existingTask.content,
        tags: updatedTags,
        priority: parsed.priority || 0
      });
      console.log(`[UPDATE]   Result: ${updateResult ? 'SUCCESS' : 'DONE'}`);
      
      if (needsProjectMove) {
        console.log(`[UPDATE]   📦 Task moved to project: ${targetProjectId}`);
      }

      return { action: 'updated', title: parsed.title, moved: needsProjectMove };
    }

    console.log(`[SKIP] No changes detected`);
    return { action: 'skipped', reason: 'no changes' };
  } else {
    // CREATE new task
    const taskType = parsed.isRecurring ? '🔄 RECURRING' : '📝 ONE-TIME';
    const syncTag = parsed.isRecurring ? NOTION_RECURRING_TAG : NOTION_SYNC_TAG;
    console.log(`[CREATE] ➕ Creating NEW ${taskType} task`);
    console.log(`[CREATE]   Title: "${parsed.title}"`);
    console.log(`[CREATE]   Sync Tag: ${syncTag}`);
    console.log(`[CREATE]   Tags: [${(parsed.tags || []).join(', ')}]`);
    console.log(`[CREATE]   Priority: ${parsed.priority}`);
    console.log(`[CREATE]   Due Date: ${parsed.dueDate || 'none'}`);
    console.log(`[CREATE]   Start Date: ${parsed.startDate || 'none'}`);
    console.log(`[CREATE]   Is All Day: ${parsed.isAllDay}`);
    if (parsed.isRecurring) {
      console.log(`[CREATE]   🔁 RRULE: ${parsed.repeatFlag}`);
    }
    if (parsed.reminders && parsed.reminders.length > 0) {
      console.log(`[CREATE]   🔔 Reminders: [${parsed.reminders.join(', ')}]`);
    }

    // Build content with Notion link for easy navigation
    const notionLink = pageId ? getNotionLink(pageId, blockId) : '';
    const content = notionLink
      ? `notion:${blockId}\n\n📎 Open in Notion:\n${notionLink}`
      : `notion:${blockId}`;

    const taskPayload = {
      title: parsed.title,
      content: content,
      tags: parsed.tags || [],
      priority: parsed.priority || 0,
      dueDate: parsed.dueDate,
      startDate: parsed.startDate,
      repeatFlag: parsed.repeatFlag,
      isRecurring: parsed.isRecurring,
      isAllDay: parsed.isAllDay,
      reminders: parsed.reminders || []
    };

    console.log(`[CREATE]   Full payload being sent to TickTick:`);
    console.log(`[CREATE]   ${JSON.stringify(taskPayload, null, 2).split('\n').join('\n[CREATE]   ')}`);

    const createResult = await createTask(taskPayload, targetProjectId);

    if (createResult) {
      console.log(`[CREATE]   ✓ SUCCESS - Task ID: ${createResult.id}`);
      console.log(`[CREATE]   Project: ${createResult.projectId}`);
      console.log(`[CREATE]   TickTick response: ${JSON.stringify(createResult, null, 2).split('\n').join('\n[CREATE]   ')}`);
    } else {
      console.log(`[CREATE]   ⚠️ No response from TickTick (might still be created)`);
    }

    return { action: 'created', title: parsed.title, recurring: parsed.isRecurring, projectId: createResult?.projectId };
  }
}

// ==================== MAIN WEBHOOK HANDLER ====================

export default async function handler(req, res) {
  // Handle verification challenge from Notion
  // Notion sends a verification_token in POST body that must be echoed back

  // GET request verification (query param)
  if (req.method === 'GET') {
    const challenge = req.query.challenge;
    if (challenge) {
      console.log('Responding to GET webhook verification challenge');
      return res.status(200).send(challenge);
    }
    return res.status(200).json({ status: 'Notion webhook endpoint ready' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // LOG EVERYTHING for debugging
  const payload = req.body;
  console.log('=== WEBHOOK RECEIVED ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(payload, null, 2));
  console.log('========================');

  // POST request verification (Notion sends verification_token in body)
  // Check for ANY verification-related field
  const token = payload.verification_token || payload.challenge || payload.token;

  if (payload.type === 'url_verification' || token) {
    console.log('🔑 VERIFICATION TOKEN RECEIVED:', token);
    // Return token in multiple formats to ensure compatibility
    return res.status(200).json({
      ok: true,
      challenge: token,
      verification_token: token
    });
  }

  // Validate environment
  if (!NOTION_TOKEN || !TICKTICK_BEARER_TOKEN || !TICKTICK_USER_ID) {
    return res.status(500).json({
      error: 'Missing environment variables',
      required: ['NOTION_TOKEN', 'TICKTICK_BEARER_TOKEN', 'TICKTICK_USER_ID']
    });
  }

  console.log('Received webhook:', JSON.stringify(payload, null, 2));

  // ==================== DEDUPLICATE WEBHOOKS ====================
  // Skip if we already processed this exact webhook (Notion retries)
  const webhookId = payload.id;
  if (webhookId && isWebhookAlreadyProcessed(webhookId)) {
    console.log(`⚠️ SKIPPING DUPLICATE WEBHOOK: ${webhookId} (attempt ${payload.attempt_number || '?'})`);
    console.log(`   Already processed within last 60 seconds`);
    return res.status(200).json({ 
      ok: true, 
      skipped: true, 
      reason: 'duplicate webhook',
      webhookId: webhookId,
      attemptNumber: payload.attempt_number
    });
  }
  
  // Mark as processed BEFORE doing any work
  if (webhookId) {
    markWebhookProcessed(webhookId);
    console.log(`✓ Webhook ${webhookId} marked as processing (attempt ${payload.attempt_number || 1})`);
  }

  // Handle different event types
  const eventType = payload.type;

  if (eventType === 'page.content_updated') {
    const updatedBlocks = payload.data?.updated_blocks || [];
    // entity.id is the page where the task exists (correct!)
    // data.parent.id is the PARENT of that page (wrong!)
    const taskPageId = payload.entity?.id || payload.data?.parent?.id || '';
    console.log(`Processing ${updatedBlocks.length} updated blocks (page: ${taskPageId})`);

    // Reset project cache for fresh data
    cachedProjects = null;

    const results = {
      processed: 0,
      created: 0,
      updated: 0,
      completed: 0,
      deleted: 0,
      skipped: 0,
      migrated: 0,
      errors: []
    };

    // ==================== STEP 1: Get target project for this page ====================
    // This checks the first 3 blocks of the page for @list:project-name directive
    let targetProjectId = `inbox${TICKTICK_USER_ID}`;
    let listDirectiveDetected = false;
    
    if (taskPageId) {
      console.log(`\n[LIST] ========================================`);
      console.log(`[LIST] STEP 1: Checking for @list: directive`);
      console.log(`[LIST] Page ID: ${taskPageId}`);
      console.log(`[LIST] ========================================`);
      targetProjectId = await getTargetProjectId(taskPageId);
      listDirectiveDetected = targetProjectId !== `inbox${TICKTICK_USER_ID}`;
      console.log(`[LIST] RESULT: Target project = ${targetProjectId}`);
      console.log(`[LIST] RESULT: Directive detected = ${listDirectiveDetected}`);
      console.log(`[LIST] ========================================\n`);
    } else {
      console.log(`[LIST] No taskPageId available, skipping @list: detection`);
    }

    // ==================== STEP 2: Check if @list: block was added/changed ====================
    // If any updated block is a paragraph containing @list:, trigger migration
    // This handles the case where user ADDS @list: to a page with existing tasks
    console.log(`\n[MIGRATE] ========================================`);
    console.log(`[MIGRATE] STEP 2: Checking if @list: was added/changed`);
    console.log(`[MIGRATE] Checking ${updatedBlocks.length} updated blocks...`);
    console.log(`[MIGRATE] ========================================`);
    
    for (const blockInfo of updatedBlocks) {
      try {
        console.log(`[MIGRATE-DEBUG] Checking block ${blockInfo.id}...`);
        const { data: block, status } = await getBlock(blockInfo.id);
        console.log(`[MIGRATE-DEBUG] Block status=${status}, type=${block?.type}`);
        
        if (status === 200 && block.type === 'paragraph' && block.paragraph?.rich_text) {
          const text = block.paragraph.rich_text.map(r => r.plain_text).join('');
          console.log(`[MIGRATE-DEBUG] Block is paragraph with text: "${text}"`);
          const listName = extractListDirective(text);
          
          if (listName) {
            console.log(`\n[MIGRATE] 📦 @list:${listName} directive detected in updated blocks!`);
            console.log(`[MIGRATE] Triggering migration for page ${taskPageId}...`);
            
            // Get project ID for migration
            const migrationProjectId = await getOrCreateProject(listName);
            console.log(`[MIGRATE] Migration target project ID: ${migrationProjectId}`);
            
            if (migrationProjectId) {
              // Find all existing tasks from this page
              console.log(`[MIGRATE] Searching for existing tasks from this page...`);
              const existingTasks = await findTasksByNotionPageId(taskPageId);
              
              if (existingTasks.length > 0) {
                console.log(`[MIGRATE] Found ${existingTasks.length} existing tasks to migrate:`);
                existingTasks.forEach((t, i) => console.log(`[MIGRATE]   ${i+1}. "${t.title}" (current project: ${t.projectId})`));
                
                const migrationResult = await migrateTasksToProject(existingTasks, migrationProjectId, listName);
                results.migrated = migrationResult.migrated;
                console.log(`[MIGRATE] ✓ Migration complete: ${migrationResult.migrated} moved, ${migrationResult.failed} failed`);
              } else {
                console.log(`[MIGRATE] No existing tasks to migrate`);
              }
              
              // Update targetProjectId for new tasks
              targetProjectId = migrationProjectId;
              console.log(`[MIGRATE] Updated targetProjectId to: ${targetProjectId}`);
            }
            
            // Only migrate once per webhook
            console.log(`[MIGRATE] Breaking after first @list: detection`);
            break;
          }
        }
      } catch (e) {
        console.log(`[MIGRATE] ✗ Could not check block ${blockInfo.id}: ${e.message}`);
      }
    }
    console.log(`[MIGRATE] ========================================\n`);

    // ==================== STEP 3: Process all updated blocks ====================
    for (const blockInfo of updatedBlocks) {
      const blockId = blockInfo.id;

      try {
        const result = await syncBlock(blockId, taskPageId, targetProjectId);
        results.processed++;

        switch (result.action) {
          case 'created': results.created++; break;
          case 'updated': results.updated++; break;
          case 'completed': results.completed++; break;
          case 'deleted': results.deleted++; break;
          case 'skipped': results.skipped++; break;
        }
      } catch (error) {
        console.error(`Error syncing block ${blockId}:`, error.message);
        results.errors.push({ blockId, error: error.message });
      }
    }

    console.log(`\nWebhook processed: ${results.created} created, ${results.updated} updated, ${results.completed} completed, ${results.deleted} deleted, ${results.skipped} skipped, ${results.migrated} migrated`);
    return res.status(200).json({
      ok: true,
      event: eventType,
      targetProject: targetProjectId,
      ...results,
      timestamp: new Date().toISOString()
    });
  }

  // Handle page.created (new page)
  if (eventType === 'page.created') {
    console.log('New page created, will sync on next cron run');
    return res.status(200).json({ ok: true, event: eventType, message: 'Acknowledged' });
  }

  // Handle page.deleted
  if (eventType === 'page.deleted') {
    const deletedPageId = payload.entity?.id;
    console.log(`[PAGE-DELETE] ========================================`);
    console.log(`[PAGE-DELETE] Page deleted: ${deletedPageId}`);
    
    if (!deletedPageId) {
      console.log(`[PAGE-DELETE] No page ID found in webhook`);
      return res.status(200).json({ ok: true, event: eventType, message: 'No page ID' });
    }

    // Find all TickTick tasks linked to this page
    console.log(`[PAGE-DELETE] Searching for tasks from this page...`);
    const tasksToDelete = await findTasksByNotionPageId(deletedPageId);
    
    if (tasksToDelete.length === 0) {
      console.log(`[PAGE-DELETE] No tasks found for this page`);
      console.log(`[PAGE-DELETE] ========================================`);
      return res.status(200).json({ 
        ok: true, 
        event: eventType, 
        pageId: deletedPageId,
        tasksFound: 0,
        tasksDeleted: 0 
      });
    }

    console.log(`[PAGE-DELETE] Found ${tasksToDelete.length} tasks to cleanup:`);
    tasksToDelete.forEach((t, i) => console.log(`[PAGE-DELETE]   ${i+1}. "${t.title}"`));

    // Batch delete all tasks at once
    const result = await batchDeleteTasks(tasksToDelete);
    
    console.log(`[PAGE-DELETE] ✓ Cleanup complete: ${result.deleted} tasks deleted`);
    console.log(`[PAGE-DELETE] ========================================`);
    
    return res.status(200).json({
      ok: true,
      event: eventType,
      pageId: deletedPageId,
      tasksFound: tasksToDelete.length,
      tasksDeleted: result.deleted,
      timestamp: new Date().toISOString()
    });
  }

  // Unknown event type - still acknowledge
  console.log(`Unknown event type: ${eventType}`);
  return res.status(200).json({ ok: true, event: eventType, message: 'Acknowledged' });
}

export const config = {
  maxDuration: 30
};
