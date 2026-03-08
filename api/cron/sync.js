/**
 * Cron Job: Reverse Sync (TickTick -> Notion)
 *
 * Handles TWO operations:
 * 1. DELETE TAG SYNC: Tasks with "delete" tag -> Delete from both systems
 * 2. COMPLETION SYNC: TickTick completions -> Notion checkboxes
 * 
 * Forward sync (Notion -> TickTick) is handled by WEBHOOKS!
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TICKTICK_COOKIE_TOKEN = process.env.TICKTICK_COOKIE_TOKEN;
const TICKTICK_BEARER_TOKEN = process.env.TICKTICK_BEARER_TOKEN;
const TICKTICK_USER_ID = process.env.TICKTICK_USER_ID;

const NOTION_API_BASE = 'https://api.notion.com/v1';
const TICKTICK_API_BASE = 'https://api.ticktick.com/open/v1';
const NOTION_SYNC_TAG = 'notion-sync';
const DELETE_TAG = 'delete';

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

async function setTodoChecked(blockId, checked) {
  return notionRequest(`/blocks/${blockId}`, {
    method: 'PATCH',
    body: JSON.stringify({ to_do: { checked } })
  });
}

async function getBlock(blockId) {
  return notionRequest(`/blocks/${blockId}`);
}

// ==================== TICKTICK API ====================

async function ticktickOpenApiRequest(endpoint, options = {}) {
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

// Remove notion-sync tag from task after successful sync
async function removeNotionSyncTag(task) {
  try {
    const newTags = (task.tags || []).filter(t => t !== NOTION_SYNC_TAG);

    const res = await fetch(`https://api.ticktick.com/api/v2/task/${task.id}`, {
      method: 'POST',
      headers: {
        'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: task.id,
        projectId: task.projectId,
        tags: newTags
      })
    });

    if (res.ok) {
      console.log(`   Tag removed from: "${task.title}"`);
      return true;
    }
    return false;
  } catch (e) {
    console.error(`   Failed to remove tag: ${e.message}`);
    return false;
  }
}

// ==================== DELETE TAG FUNCTIONS ====================

async function findTasksWithDeleteTag() {
  const tasksToDelete = [];

  // Method 1: Search API (cookie-based, fastest)
  if (TICKTICK_COOKIE_TOKEN) {
    try {
      const searchUrl = `https://api.ticktick.com/api/v2/search/all?keywords=${DELETE_TAG}`;
      const response = await fetch(searchUrl, {
        headers: {
          'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.tasks && data.tasks.length > 0) {
          for (const task of data.tasks) {
            if (task.tags && task.tags.includes(DELETE_TAG)) {
              tasksToDelete.push(task);
            }
          }
          if (tasksToDelete.length > 0) {
            console.log(`[DELETE] Found ${tasksToDelete.length} tasks with "${DELETE_TAG}" tag`);
            return tasksToDelete;
          }
        }
      }
    } catch (e) {
      console.log(`[DELETE] Search API failed, trying Open API`);
    }
  }

  // Method 2: Fallback to Open API
  if (TICKTICK_BEARER_TOKEN && TICKTICK_USER_ID) {
    console.log(`[DELETE] Scanning projects via Open API...`);
    const projects = await ticktickOpenApiRequest('/project');
    const inboxId = `inbox${TICKTICK_USER_ID}`;
    const projectIds = [...(projects || []).map(p => p.id), inboxId];

    for (const projectId of projectIds) {
      try {
        const data = await ticktickOpenApiRequest(`/project/${projectId}/data`);
        if (data && data.tasks) {
          for (const task of data.tasks) {
            if (task.tags && task.tags.includes(DELETE_TAG)) {
              tasksToDelete.push(task);
            }
          }
        }
      } catch (e) {
        // Skip failed projects
      }
    }
  }

  console.log(`[DELETE] Found ${tasksToDelete.length} tasks with "${DELETE_TAG}" tag`);
  return tasksToDelete;
}

async function deleteNotionBlock(blockId) {
  console.log(`[DELETE] Deleting Notion block: ${blockId}`);
  const response = await fetch(`${NOTION_API_BASE}/blocks/${blockId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28'
    }
  });

  if (response.status === 200) {
    console.log(`[DELETE] ✓ Notion block deleted`);
    return true;
  } else if (response.status === 404) {
    console.log(`[DELETE] Notion block already gone`);
    return true;
  } else {
    console.log(`[DELETE] ✗ Failed: ${response.status}`);
    return false;
  }
}

async function deleteTickTickTask(taskId, projectId) {
  console.log(`[DELETE] Deleting TickTick task: ${taskId}`);
  await ticktickOpenApiRequest(`/project/${projectId}/task/${taskId}`, {
    method: 'DELETE'
  });
  console.log(`[DELETE] ✓ TickTick task deleted`);
  return true;
}

function extractNotionBlockId(content) {
  if (!content) return null;
  const match = content.match(/notion:([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

async function processDeleteTags() {
  console.log('\n========== DELETE TAG SYNC ==========');

  const stats = { found: 0, notionDeleted: 0, ticktickDeleted: 0, errors: 0 };

  const tasksToDelete = await findTasksWithDeleteTag();
  stats.found = tasksToDelete.length;

  if (tasksToDelete.length === 0) {
    console.log(`[DELETE] No tasks with "${DELETE_TAG}" tag`);
    return stats;
  }

  for (const task of tasksToDelete) {
    console.log(`\n[DELETE] Processing: "${task.title}"`);

    try {
      const notionBlockId = extractNotionBlockId(task.content);

      if (notionBlockId) {
        console.log(`[DELETE] Has Notion block: ${notionBlockId}`);
        const notionSuccess = await deleteNotionBlock(notionBlockId);
        if (notionSuccess) stats.notionDeleted++;
      } else {
        console.log(`[DELETE] No Notion block (TickTick-only task)`);
      }

      await deleteTickTickTask(task.id, task.projectId);
      stats.ticktickDeleted++;

    } catch (error) {
      console.error(`[DELETE] Error: ${error.message}`);
      stats.errors++;
    }
  }

  console.log(`[DELETE] Done: ${stats.notionDeleted} Notion blocks, ${stats.ticktickDeleted} TickTick tasks deleted`);
  return stats;
}

// ==================== COMPLETION SYNC FUNCTIONS ====================

async function getCompletedNotionTasks() {
  if (!TICKTICK_COOKIE_TOKEN) {
    console.log('No cookie token, skipping completion sync');
    return [];
  }

  try {
    // Use tag-based completed task API - ONE call instead of per-project!
    const allTasks = [];
    let nextToken = '';

    do {
      const res = await fetch('https://api.ticktick.com/api/v2/tag/completedTask', {
        method: 'POST',
        headers: {
          'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tags: [NOTION_SYNC_TAG],
          token: nextToken,
          limit: 50
        })
      });

      if (!res.ok) {
        console.log('Cookie expired or API error');
        return [];
      }

      const data = await res.json();
      if (data.tasks && Array.isArray(data.tasks)) {
        allTasks.push(...data.tasks);
      }
      nextToken = data.nextToken || '';
    } while (nextToken);

    console.log(`Found ${allTasks.length} completed tasks with notion-sync tag`);
    return allTasks;
  } catch (e) {
    console.error('Error:', e.message);
    return [];
  }
}

// ==================== MAIN HANDLER ====================

export default async function handler(req, res) {
  console.log('\n========== CRON SYNC JOB ==========');
  console.log(`[START] ${new Date().toISOString()}`);

  if (!NOTION_TOKEN) {
    return res.status(500).json({
      error: 'Missing NOTION_TOKEN'
    });
  }

  const results = {
    completion: { checked: 0, skipped: 0, errors: 0, tagsRemoved: 0 },
    delete: { found: 0, notionDeleted: 0, ticktickDeleted: 0, errors: 0 }
  };

  try {
    // ===== 1. DELETE TAG SYNC =====
    if (TICKTICK_BEARER_TOKEN && TICKTICK_USER_ID) {
      results.delete = await processDeleteTags();
    } else {
      console.log('[DELETE] Skipped - missing TICKTICK_BEARER_TOKEN or TICKTICK_USER_ID');
    }

    // ===== 2. COMPLETION SYNC (TickTick -> Notion) =====
    console.log('\n========== COMPLETION SYNC ==========');

    if (!TICKTICK_COOKIE_TOKEN) {
      console.log('[COMPLETION] Skipped - missing TICKTICK_COOKIE_TOKEN');
    } else {
      const completedTasks = await getCompletedNotionTasks();

      for (const task of completedTasks) {
        const match = task.content ? task.content.match(/notion:([a-f0-9-]+)/) : null;
        if (!match) continue;

        const notionBlockId = match[1];

        if (task.repeatFlag) {
          results.completion.skipped++;
          continue;
        }

        try {
          const block = await getBlock(notionBlockId);

          if (block.object === 'error') {
            console.log(`Block not found, cleaning up: "${task.title}"`);
            await removeNotionSyncTag(task);
            results.completion.tagsRemoved++;
            results.completion.errors++;
            continue;
          }

          if (block.to_do && !block.to_do.checked) {
            console.log(`Checking: "${task.title}"`);
            await setTodoChecked(notionBlockId, true);
            results.completion.checked++;
          } else {
            results.completion.skipped++;
          }

          const tagRemoved = await removeNotionSyncTag(task);
          if (tagRemoved) results.completion.tagsRemoved++;
        } catch (e) {
          results.completion.errors++;
        }
      }

      console.log(`[COMPLETION] Done: ${results.completion.checked} checked, ${results.completion.skipped} skipped`);
    }

    console.log('\n========== CRON COMPLETE ==========');
    return res.status(200).json({
      ok: true,
      ...results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Sync error:', error);
    return res.status(500).json({ error: error.message });
  }
}

export const config = {
  maxDuration: 30
};
